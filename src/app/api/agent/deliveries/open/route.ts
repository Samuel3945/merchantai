/**
 * GET/POST /api/agent/deliveries/open
 *
 * Lets the WhatsApp agent (1) check whether a customer has an OPEN
 * (addable) delivery order and (2) add items to it. The bot only ever
 * knows the customer's PHONE — never an order id — so both handlers
 * resolve the order by (organizationId, customerPhone, status IN
 * ('pending','assigned')), most recent first.
 *
 * GET  → read-only lookup, returns items/total but NEVER the order id (the
 *        agent has no business referencing an id directly).
 * POST → re-validates ownership + status + stock server-side (same
 *        distrust-the-caller posture as POST /api/agent/deliveries),
 *        merges the new items into the order, recomputes
 *        subtotal/deliveryFee/total from libs/delivery-fee.ts, and — best
 *        effort, after the DB write commits — pings the assigned courier
 *        so they don't miss the addition mid-route.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { resolveDeliveryFee } from '@/libs/delivery-fee';
import { sendWhatsAppTextForOrg } from '@/libs/delivery-whatsapp';
import { deliveryEventsSchema, deliveryOrdersSchema, posUsersSchema, productsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

// Statuses an order can still receive new items on. Once it's 'in_transit'
// the goods already left, so the bot must not silently append to it.
const ADDABLE_STATUSES = ['pending', 'assigned'] as const;

type DeliveryOrderRow = typeof deliveryOrdersSchema.$inferSelect;

/** Finds the customer's most recent addable delivery order, org-scoped. */
async function findOpenOrder(
  organizationId: string,
  phone: string,
): Promise<DeliveryOrderRow | null> {
  const [order] = await db
    .forOrg(organizationId)
    .select()
    .from(deliveryOrdersSchema)
    .where(
      and(
        eq(deliveryOrdersSchema.customerPhone, phone),
        inArray(deliveryOrdersSchema.status, ADDABLE_STATUSES),
      ),
    )
    .orderBy(desc(deliveryOrdersSchema.createdAt))
    .limit(1);

  return order ?? null;
}

/**
 * Finds the customer's most recent delivery order regardless of status,
 * org-scoped. POST needs this (rather than findOpenOrder) so it can tell
 * "no order at all" (404 no_open_order) apart from "an order exists but it
 * already moved past pending/assigned" (409 order_not_addable) — e.g. the
 * courier picked it up between the bot's last GET and this POST.
 */
async function findMostRecentOrder(
  organizationId: string,
  phone: string,
): Promise<DeliveryOrderRow | null> {
  const [order] = await db
    .forOrg(organizationId)
    .select()
    .from(deliveryOrdersSchema)
    .where(eq(deliveryOrdersSchema.customerPhone, phone))
    .orderBy(desc(deliveryOrdersSchema.createdAt))
    .limit(1);

  return order ?? null;
}

// ─── GET ────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  if (ctx.capabilities.orders !== true) {
    return NextResponse.json(
      { error: 'Channel does not have orders capability' },
      { status: 403 },
    );
  }

  const { organizationId } = ctx;
  const { searchParams } = new URL(req.url);
  const phone = searchParams.get('phone');

  if (!phone || !phone.trim()) {
    return NextResponse.json({ error: 'Invalid phone' }, { status: 400 });
  }

  const order = await findOpenOrder(organizationId, phone.trim());

  if (!order) {
    return NextResponse.json({ found: false });
  }

  // No id in the response — the bot works by phone only, and has no
  // business referencing an order id directly.
  return NextResponse.json({
    found: true,
    status: order.status,
    items: order.items.map(i => ({ name: i.name, qty: i.qty })),
    total: Number(order.total),
  });
}

// ─── POST ───────────────────────────────────────────────────────────────

const openDeliveryItemSchema = z
  .object({
    productId: z.string().uuid(),
    qty: z.number().int().positive().max(100000),
    // price and stock are NOT accepted — server re-fetches them, same
    // posture as agentDeliveryItemSchema.
  })
  .strict();

const addItemsToOpenOrderSchema = z
  .object({
    phone: z.string().trim().min(1),
    items: z.array(openDeliveryItemSchema).min(1),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  if (ctx.capabilities.orders !== true) {
    return NextResponse.json(
      { error: 'Channel does not have orders capability' },
      { status: 403 },
    );
  }

  let body: z.infer<typeof addItemsToOpenOrderSchema>;
  try {
    body = addItemsToOpenOrderSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { organizationId } = ctx;

  const order = await findMostRecentOrder(organizationId, body.phone.trim());
  if (!order) {
    return NextResponse.json(
      { error: 'no_open_order', code: 'no_open_order' },
      { status: 404 },
    );
  }

  // Defense against a race: the order may have moved to 'in_transit' between
  // the bot's last GET and this POST (e.g. the courier just picked it up).
  if (!ADDABLE_STATUSES.includes(order.status as (typeof ADDABLE_STATUSES)[number])) {
    return NextResponse.json(
      { error: 'order_not_addable', code: 'order_not_addable', status: order.status },
      { status: 409 },
    );
  }

  // Aggregate requested qty per productId first (mirrors POST
  // /api/agent/deliveries) so duplicate productIds in one request are summed
  // before the stock check.
  const requestedQtyByProductId = new Map<string, number>();
  for (const item of body.items) {
    requestedQtyByProductId.set(
      item.productId,
      (requestedQtyByProductId.get(item.productId) ?? 0) + item.qty,
    );
  }

  // Existing qty already committed to the order per productId (lines without
  // a productId — legacy/manual free-text — are left untouched and excluded
  // from this map; they can't be matched to a new item anyway).
  const existingQtyByProductId = new Map<string, number>();
  for (const item of order.items) {
    if (item.productId) {
      existingQtyByProductId.set(
        item.productId,
        (existingQtyByProductId.get(item.productId) ?? 0) + item.qty,
      );
    }
  }

  const newItems: Array<{ productId: string; name: string; qty: number; price: number }> = [];

  for (const [productId, requestedQty] of requestedQtyByProductId) {
    const [product] = await db
      .forOrg(organizationId)
      .select({
        id: productsSchema.id,
        name: productsSchema.name,
        price: productsSchema.price,
        stock: productsSchema.stock,
        deleted: productsSchema.deleted,
      })
      .from(productsSchema)
      .where(and(eq(productsSchema.id, productId), eq(productsSchema.deleted, false)))
      .limit(1);

    if (!product) {
      return NextResponse.json(
        { error: 'Product not found', code: 'product_not_found', productId },
        { status: 422 },
      );
    }

    // Stock must cover what's ALREADY on the order plus the new request — the
    // order already reserved nothing physically (delivery stock is only
    // decremented at 'delivered'), so the current shelf stock is the real
    // ceiling for old_qty + new_qty combined.
    const existingQty = existingQtyByProductId.get(productId) ?? 0;
    const totalQty = existingQty + requestedQty;

    if (product.stock < totalQty) {
      return NextResponse.json(
        {
          error: 'Insufficient stock',
          code: 'insufficient_stock',
          productId,
          available: product.stock,
          requested: totalQty,
        },
        { status: 422 },
      );
    }

    // Server price + name only — the LLM never supplies either.
    newItems.push({
      productId,
      name: product.name,
      qty: requestedQty,
      price: Number(product.price),
    });
  }

  // Merge: keep existing lines; for each new item, sum onto an existing line
  // with the same productId if present, otherwise append a new line.
  const mergedItems = order.items.map(i => ({ ...i }));
  for (const newItem of newItems) {
    const existingLine = mergedItems.find(i => i.productId === newItem.productId);
    if (existingLine) {
      existingLine.qty += newItem.qty;
      // Keep the freshest server-fetched name/price on the merged line.
      existingLine.name = newItem.name;
      existingLine.price = newItem.price;
    } else {
      mergedItems.push(newItem);
    }
  }

  const subtotal = mergedItems.reduce((sum, it) => sum + it.qty * it.price, 0);
  const deliveryFee = await resolveDeliveryFee(organizationId, subtotal);
  const total = subtotal + deliveryFee;

  const addedNames = newItems.map(i => `${i.qty}x ${i.name}`).join(', ');

  // deliveryEventsSchema is a child table (no organizationId-scoped proxy
  // registration — its rows are reached through the parent delivery order),
  // so this transaction drops to the audited raw-db escape hatch. Every
  // query below still filters explicitly by organizationId, matching the
  // guarantee db.forOrg() would have injected automatically.
  const rawDb = db.unsafeNoOrgFilter(
    'agent deliveries/open POST: update the delivery order + insert its '
    + 'note event, both explicitly scoped by organizationId already '
    + 'verified via findOpenOrder() above',
  );

  // Write first, notify after — a courier-notify failure must never roll
  // back an order update the customer already committed to.
  await rawDb.transaction(async (tx) => {
    await tx
      .update(deliveryOrdersSchema)
      .set({
        items: mergedItems,
        subtotal: subtotal.toFixed(2),
        deliveryFee: deliveryFee.toFixed(2),
        total: total.toFixed(2),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deliveryOrdersSchema.id, order.id),
          eq(deliveryOrdersSchema.organizationId, organizationId),
        ),
      );

    await tx.insert(deliveryEventsSchema).values({
      deliveryOrderId: order.id,
      organizationId,
      type: 'note',
      note: `Items agregados por el cliente: ${addedNames}`,
      actorType: 'api',
      createdBy: ctx.tokenId ?? ctx.channelId,
    });
  });

  // Best-effort courier notification — never throws, never blocks the response.
  if (order.courierId) {
    const [courier] = await db
      .forOrg(organizationId)
      .select({ phone: posUsersSchema.phone })
      .from(posUsersSchema)
      .where(eq(posUsersSchema.id, order.courierId))
      .limit(1);

    if (courier?.phone) {
      await sendWhatsAppTextForOrg(
        organizationId,
        courier.phone,
        `🛵 Se agregaron productos al pedido de ${order.customerName ?? 'un cliente'}: ${addedNames}. Nuevo total $${total.toFixed(2)}.`,
      );
    }
  }

  return NextResponse.json({
    status: 'ok',
    added: newItems.map(i => ({ name: i.name, qty: i.qty })),
    newTotal: total,
  });
}
