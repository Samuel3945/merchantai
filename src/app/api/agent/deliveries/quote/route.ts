/**
 * POST /api/agent/deliveries/quote
 *
 * Lets the WhatsApp agent quote a delivery BEFORE the customer confirms —
 * subtotal, shipping and total are computed from REAL product prices
 * (db.forOrg) and the org's delivery fee config (libs/delivery-fee.ts), never
 * from caller input. Mirrors the ownership + stock checks in
 * POST /api/agent/deliveries so a quote and the resulting create never
 * disagree.
 *
 * Guards (in order):
 *   1. requireAgentAuth       — invalid/expired token → 401
 *   2. capabilities.orders    — missing flag → 403
 *   3. agentDeliveryQuoteSchema.parse — bad body → 400
 *   4. Each product in db.forOrg — missing/deleted → 422 product_not_found
 *   5. stock < qty            — 422 insufficient_stock (agent token: no oversell)
 *
 * No delivery order is created here — this is a read-only computation.
 */
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { agentDeliveryQuoteSchema } from '@/features/delivery/agent-delivery-validation';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { resolveDeliveryFee } from '@/libs/delivery-fee';
import { productsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

type QuoteLine = {
  productId: string;
  name: string;
  qty: number;
  price: number;
  lineTotal: number;
};

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

  let body: ReturnType<typeof agentDeliveryQuoteSchema.parse>;
  try {
    body = agentDeliveryQuoteSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { organizationId } = ctx;

  // Re-fetch price + stock for each item; validate ownership and stock.
  // Aggregate requested qty per productId first so duplicate productIds in the
  // request are summed before the stock check (mirrors POST /api/agent/deliveries).
  const qtyByProductId = new Map<string, number>();
  for (const item of body.items) {
    qtyByProductId.set(item.productId, (qtyByProductId.get(item.productId) ?? 0) + item.qty);
  }

  const items: QuoteLine[] = [];

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

    // Agent tokens never allow oversell (mirrors POST /api/agent/deliveries).
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

    const price = Number(product.price);
    items.push({
      productId,
      name: product.name,
      qty: totalQty,
      price,
      lineTotal: price * totalQty,
    });
  }

  const subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
  const shipping = await resolveDeliveryFee(organizationId, subtotal);
  const total = subtotal + shipping;

  return NextResponse.json({ subtotal, shipping, total, items }, { status: 200 });
}
