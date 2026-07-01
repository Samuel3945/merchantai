/**
 * POST /api/agent/deliveries
 *
 * Full ownership chain + server price re-fetch for n8n agent delivery creation.
 *
 * Guards (in order):
 *   1. requireAgentAuth       — invalid/expired token → 401
 *   2. capabilities.orders    — missing flag → 403
 *   3. agentDeliveryCreateSchema.parse — bad body → 400 (deliveryFee rejected: not in schema)
 *   4. idempotencyKey dedup   — if (org, key) row exists → 200 (no duplicate)
 *   5. customerId (if supplied) in db.forOrg — cross-org → 404
 *   6. Each product in db.forOrg — missing/deleted → 422 product_not_found
 *   7. stock < qty            — 422 insufficient_stock (agent token: no oversell)
 *   8. resolveDeliveryFee — shipping computed from the org's config and the
 *      REAL subtotal, never from caller input
 *   9. createDeliveryForOrg(source:'ai_agent', actorType:'api', createdBy:tokenId??channelId)
 *
 * The LLM MUST NOT supply price, stock or the delivery fee — they are all
 * discarded/rejected by the schema, and the server re-fetches/recomputes them
 * from db.forOrg + libs/delivery-fee.ts at order time.
 */
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { agentDeliveryCreateSchema } from '@/features/delivery/agent-delivery-validation';
import { createDeliveryForOrg } from '@/features/delivery/intake';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { resolveDeliveryFee } from '@/libs/delivery-fee';
import { customersSchema, deliveryOrdersSchema, productsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

/** Returns true when the error is a Postgres unique-constraint violation (23505). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code: unknown }).code === '23505'
  );
}

export async function POST(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  // Capability gate.
  if (ctx.capabilities.orders !== true) {
    return NextResponse.json(
      { error: 'Channel does not have orders capability' },
      { status: 403 },
    );
  }

  let body: ReturnType<typeof agentDeliveryCreateSchema.parse>;
  try {
    body = agentDeliveryCreateSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { organizationId } = ctx;
  // tokenId is null in service-secret mode; fall back to the channel id so the
  // audit record always has a meaningful actor.
  const createdBy = ctx.tokenId ?? ctx.channelId;

  // Step 4: idempotency dedup — if a delivery with this key already exists,
  // return it immediately without creating a duplicate.
  if (body.idempotencyKey) {
    const [existing] = await db
      .forOrg(organizationId)
      .select({ id: deliveryOrdersSchema.id, source: deliveryOrdersSchema.source })
      .from(deliveryOrdersSchema)
      .where(eq(deliveryOrdersSchema.idempotencyKey, body.idempotencyKey))
      .limit(1);

    if (existing) {
      return NextResponse.json({ id: existing.id, source: existing.source }, { status: 200 });
    }
  }

  // Step 5: verify customer belongs to org (if supplied).
  let customerName: string | null = null;
  const customerPhone: string | null = body.phone ?? null;

  if (body.customerId) {
    const [customer] = await db
      .forOrg(organizationId)
      .select({ id: customersSchema.id, name: customersSchema.name })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.id, body.customerId),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);

    if (!customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    customerName = customer.name;
  }

  // Steps 6 + 7: re-fetch price + stock for each item; validate ownership and stock.
  // Aggregate requested qty per productId first so duplicate productIds in the
  // request are summed before the stock check (prevents [X,8]+[X,8] bypassing
  // a stock of 10).
  const qtyByProductId = new Map<string, number>();
  for (const item of body.items) {
    qtyByProductId.set(item.productId, (qtyByProductId.get(item.productId) ?? 0) + item.qty);
  }

  const translatedItems: Array<{ name: string; qty: number; price: number }> = [];

  for (const [productId, totalQty] of qtyByProductId) {
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
      .where(
        and(
          eq(productsSchema.id, productId),
          eq(productsSchema.deleted, false),
        ),
      )
      .limit(1);

    if (!product) {
      return NextResponse.json(
        { error: 'Product not found', code: 'product_not_found', productId },
        { status: 422 },
      );
    }

    // Agent tokens never allow oversell (mirrors paired pos_token.allowOversell=false).
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

    // Server price only — LLM price discarded.
    translatedItems.push({
      name: product.name,
      qty: totalQty,
      price: Number(product.price),
    });
  }

  // Step 8: compute the delivery fee server-side from the org's config and the
  // REAL subtotal (translatedItems already carries server-fetched prices).
  // The caller can never influence this value — agentDeliveryCreateSchema
  // does not accept a deliveryFee field at all.
  const subtotal = translatedItems.reduce((sum, it) => sum + it.qty * it.price, 0);
  const shipping = await resolveDeliveryFee(organizationId, subtotal);

  // Step 9: create the delivery with ai_agent attribution.
  try {
    const delivery = await createDeliveryForOrg(
      organizationId,
      {
        customerName,
        customerPhone,
        address: body.address,
        addressNotes: body.addressNotes,
        items: translatedItems,
        deliveryFee: shipping,
        notes: body.notes,
      },
      {
        source: 'ai_agent',
        actorType: 'api',
        createdBy,
        idempotencyKey: body.idempotencyKey,
      },
    );

    return NextResponse.json({ id: delivery.id, source: 'ai_agent' }, { status: 201 });
  } catch (err) {
    // Race-condition safety: if the unique constraint fires concurrently,
    // re-select the existing row and return it as a dedup response.
    if (body.idempotencyKey && isUniqueConstraintViolation(err)) {
      const [existing] = await db
        .forOrg(organizationId)
        .select({ id: deliveryOrdersSchema.id, source: deliveryOrdersSchema.source })
        .from(deliveryOrdersSchema)
        .where(eq(deliveryOrdersSchema.idempotencyKey, body.idempotencyKey))
        .limit(1);

      if (existing) {
        return NextResponse.json({ id: existing.id, source: existing.source }, { status: 200 });
      }
    }

    throw err;
  }
}
