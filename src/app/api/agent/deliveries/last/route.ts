/**
 * GET /api/agent/deliveries/last
 *
 * Returns the customer's MOST RECENT delivery name + address so the bot can
 * offer to reuse them ("¿te lo mando a la misma dirección?") instead of
 * re-asking every time. Read-only, org-scoped, resolved by phone — the bot
 * works by phone only and never sees an order id.
 */
import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { deliveryOrdersSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

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

  const [order] = await db
    .forOrg(organizationId)
    .select({
      name: deliveryOrdersSchema.customerName,
      address: deliveryOrdersSchema.address,
      addressNotes: deliveryOrdersSchema.addressNotes,
    })
    .from(deliveryOrdersSchema)
    .where(eq(deliveryOrdersSchema.customerPhone, phone.trim()))
    .orderBy(desc(deliveryOrdersSchema.createdAt))
    .limit(1);

  if (!order) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    name: order.name,
    address: order.address,
    addressNotes: order.addressNotes,
  });
}
