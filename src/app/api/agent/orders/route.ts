/**
 * POST /api/agent/orders
 *
 * The n8n WhatsApp agent creates a POS SALE, attributed to the org's OPEN cash
 * session (caja). This is MONEY + STOCK code: no oversell, no double-booking,
 * no cross-tenant leaks. It shares its sale-creation core (createSaleForOrg,
 * extracted from the dashboard's createSale) with the dashboard action — so
 * this endpoint gets the exact same FIFO/stock/payment/credito logic the
 * dashboard already relies on, not a third re-implementation.
 *
 * Guards (in order):
 *   1. requireAgentAuth              — invalid/expired token → 401
 *   2. capabilities.orders === true  — missing flag → 403, BEFORE any DB query
 *   3. agentOrderCreateSchema.strict().parse — bad body → 422; a credito-like
 *      paymentMethod is also rejected here (this endpoint requires an open
 *      caja — credito would bypass that requirement entirely)
 *   4. idempotencyKey dedup — if (org, key) already has a sale, return it as
 *      200 (belt; the 23505 catch inside createSaleForOrg is the suspenders)
 *   5. every productId belongs to org, not deleted, status='published',
 *      requested qty (summed per productId) <= stock → else 422. Duplicate
 *      productIds in one order are summed BEFORE both the stock check and the
 *      call to createSaleForOrg (mirrors /api/agent/deliveries — prevents
 *      [X,8]+[X,8] bypassing a stock of 10; createSaleForOrg validates each
 *      input line independently and would not catch that on its own)
 *   6. customerId (if supplied) belongs to org → else 422
 *   7. resolve the org's OPEN caja: any device, most-recently-opened wins (no
 *      posTokenId to scope by — WhatsApp is not a physical till) → 409
 *      no_open_caja if none is open
 *   8. createSaleForOrg({ actorType: 'api', posTokenId: session.posTokenId,
 *      idempotencyKey, ... }) — same core, same audit trail (logAction inside
 *      it already covers the actorType:'api' convention used by
 *      /api/agent/deliveries)
 *   9. 201 (or 200 if createSaleForOrg's own 23505 race-catch deduped it)
 *
 * The LLM MUST NOT supply price or stock — only productId/qty are read from
 * the body; price/stock are always re-fetched/re-validated server-side.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSaleForOrg } from '@/actions/sales';
import { requireAgentAuth } from '@/libs/agent-auth';
import { isCreditoMethod } from '@/libs/creditos-math';
import { db } from '@/libs/db-context';
import {
  cashSessionsSchema,
  customersSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
} from '@/models/Schema';

export const dynamic = 'force-dynamic';

const DEFAULT_PAYMENT_METHOD = 'Contraentrega';

const agentOrderItemSchema = z
  .object({
    productId: z.string().uuid(),
    qty: z.number().int().positive(),
  })
  .strict();

const agentOrderCreateSchema = z
  .object({
    items: z.array(agentOrderItemSchema).min(1),
    paymentMethod: z.string().trim().min(1).max(100).optional(),
    customerId: z.string().uuid().optional(),
    notes: z.string().trim().max(1000).optional(),
    // Required: exactly-once creation. The n8n workflow supplies the WhatsApp
    // message id (or equivalent) so a retry never double-books stock/cash.
    idempotencyKey: z.string().uuid(),
  })
  .strict();

type OrderItemLine = {
  productId: string;
  name: string;
  qty: number;
  unitPrice: string;
  lineTotal: string;
};

type OrderResponseBody = {
  id: string;
  saleNumber: number | null;
  total: string;
  status: string;
  caja: { sessionId: string | null };
  items: OrderItemLine[];
};

// sale_items is a CHILD_TABLE — db.forOrg() refuses direct access by design
// (join it from the parent tenant table, or use the explicit escape hatch).
// The parent sale row is always fetched org-scoped first, so reading its
// children by sale_id here can never cross a tenant boundary.
async function loadItemLines(saleId: string): Promise<OrderItemLine[]> {
  const rawDb = db.unsafeNoOrgFilter(
    'agent orders: read sale_items for a sale id already verified to belong '
    + 'to this org via the parent sales row (idempotency dedup response)',
  );
  const rows = await rawDb
    .select({
      productId: saleItemsSchema.productId,
      name: saleItemsSchema.productName,
      qty: saleItemsSchema.qty,
      unitPrice: saleItemsSchema.price,
      lineTotal: saleItemsSchema.subtotal,
    })
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, saleId));

  return rows.map(r => ({
    productId: r.productId,
    name: r.name,
    qty: Number(r.qty),
    unitPrice: r.unitPrice,
    lineTotal: r.lineTotal,
  }));
}

// Resolves the currently-open session scoped to a specific posTokenId (a
// device uuid, or null for the admin/no-device session) — used to report
// `caja.sessionId` on the idempotency-dedup response path. May legitimately
// be null (e.g. the caja closed since the original order was placed).
async function findSessionIdForToken(
  organizationId: string,
  posTokenId: string | null,
): Promise<string | null> {
  const [session] = await db
    .forOrg(organizationId)
    .select({ id: cashSessionsSchema.id })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.status, 'open'),
        posTokenId === null
          ? isNull(cashSessionsSchema.posTokenId)
          : eq(cashSessionsSchema.posTokenId, posTokenId),
      ),
    )
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(1);
  return session?.id ?? null;
}

export async function POST(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  // Capability gate — BEFORE any DB query.
  if (ctx.capabilities.orders !== true) {
    return NextResponse.json(
      { error: 'Channel does not have orders capability' },
      { status: 403 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 422 });
  }

  const parsed = agentOrderCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;

  const paymentMethod = body.paymentMethod?.trim() || DEFAULT_PAYMENT_METHOD;
  // This endpoint hard-requires an open caja; credito sales don't move cash
  // and would bypass that requirement (see the POS route's requiresOpenCash
  // rule) — so an agent order is never allowed to pay via credito.
  if (isCreditoMethod(paymentMethod)) {
    return NextResponse.json(
      {
        error: 'credito_not_allowed',
        message:
          'Este canal no puede registrar ventas a crédito; se requiere una caja abierta.',
      },
      { status: 422 },
    );
  }

  const { organizationId } = ctx;
  const actorId = ctx.tokenId ?? ctx.channelId;

  // Step 4: idempotency short-circuit — belt-and-suspenders with the 23505
  // catch inside createSaleForOrg. Avoids re-running validation/caja lookup
  // for an already-completed retry.
  const [existingSale] = await db
    .forOrg(organizationId)
    .select()
    .from(salesSchema)
    .where(eq(salesSchema.saleIdempotencyKey, body.idempotencyKey))
    .limit(1);

  if (existingSale) {
    const items = await loadItemLines(existingSale.id);
    const sessionId = await findSessionIdForToken(
      organizationId,
      existingSale.posTokenId ?? null,
    );
    const responseBody: OrderResponseBody = {
      id: existingSale.id,
      saleNumber: existingSale.saleNumber,
      total: existingSale.total,
      status: existingSale.status,
      caja: { sessionId },
      items,
    };
    return NextResponse.json(responseBody, { status: 200 });
  }

  // Step 5: server-side ownership + oversell validation. Aggregate requested
  // qty per productId FIRST so duplicate productIds in one order are summed
  // before the stock check (and before createSaleForOrg, which validates each
  // input line independently and would not itself catch [X,8]+[X,8] bypassing
  // a stock of 10 — see /api/agent/deliveries for the same defensive pattern).
  const qtyByProductId = new Map<string, number>();
  for (const item of body.items) {
    qtyByProductId.set(
      item.productId,
      (qtyByProductId.get(item.productId) ?? 0) + item.qty,
    );
  }

  for (const [productId, totalQty] of qtyByProductId) {
    const [product] = await db
      .forOrg(organizationId)
      .select({
        id: productsSchema.id,
        status: productsSchema.status,
        stock: productsSchema.stock,
        deleted: productsSchema.deleted,
      })
      .from(productsSchema)
      .where(eq(productsSchema.id, productId))
      .limit(1);

    if (!product || product.deleted || product.status !== 'published') {
      return NextResponse.json(
        {
          error: 'product_not_found',
          message: 'Producto no encontrado o no disponible para la venta.',
          productId,
        },
        { status: 422 },
      );
    }

    if (product.stock < totalQty) {
      return NextResponse.json(
        {
          error: 'insufficient_stock',
          message: 'Stock insuficiente para completar el pedido.',
          productId,
          available: product.stock,
          requested: totalQty,
        },
        { status: 422 },
      );
    }
  }

  // Step 6: customer (if supplied) must belong to this org.
  if (body.customerId) {
    const [customer] = await db
      .forOrg(organizationId)
      .select({ id: customersSchema.id })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.id, body.customerId),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);

    if (!customer) {
      return NextResponse.json(
        { error: 'customer_not_found', message: 'Cliente no encontrado.' },
        { status: 422 },
      );
    }
  }

  // Step 7: the org's OPEN caja — any device, most-recently-opened wins. This
  // endpoint has no physical-device concept (WhatsApp is not a till), so
  // unlike the POS route it does not scope the lookup to a specific
  // posTokenId.
  const [openSession] = await db
    .forOrg(organizationId)
    .select({
      id: cashSessionsSchema.id,
      posTokenId: cashSessionsSchema.posTokenId,
    })
    .from(cashSessionsSchema)
    .where(eq(cashSessionsSchema.status, 'open'))
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(1);

  if (!openSession) {
    return NextResponse.json(
      {
        error: 'no_open_caja',
        message:
          'No hay una caja abierta. Pedile al comercio que abra la caja para tomar pedidos.',
      },
      { status: 409 },
    );
  }

  // Step 8: create the sale via the SAME core the dashboard uses.
  let sale: Awaited<ReturnType<typeof createSaleForOrg>>;
  try {
    sale = await createSaleForOrg({
      orgId: organizationId,
      actorId,
      actorType: 'api',
      items: [...qtyByProductId].map(([productId, qty]) => ({ productId, qty })),
      paymentType: paymentMethod,
      notes: body.notes ?? null,
      posTokenId: openSession.posTokenId ?? null,
      idempotencyKey: body.idempotencyKey,
    });
  } catch (err) {
    // A race between our pre-checks (above) and createSaleForOrg's own
    // transactional FOR UPDATE validation (e.g. concurrent stock depletion)
    // surfaces as a thrown Error here — report it the same way as the other
    // validation failures instead of a bare 500.
    return NextResponse.json(
      {
        error: 'sale_failed',
        message: err instanceof Error ? err.message : 'No se pudo crear la venta.',
      },
      { status: 422 },
    );
  }

  const responseBody: OrderResponseBody = {
    id: sale.id,
    saleNumber: sale.saleNumber,
    total: sale.total,
    status: sale.status,
    caja: { sessionId: openSession.id },
    items: sale.items.map(it => ({
      productId: it.productId,
      name: it.productName,
      qty: Number(it.qty),
      unitPrice: it.price,
      lineTotal: it.subtotal,
    })),
  };

  return NextResponse.json(responseBody, { status: sale.deduped ? 200 : 201 });
}
