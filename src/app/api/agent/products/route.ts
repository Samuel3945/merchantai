/**
 * GET /api/agent/products
 *
 * Capability-gated product lookup for the n8n delivery agent.
 * Price and stock ALWAYS come from db.forOrg — LLM-supplied values are never used.
 *
 * Guards (in order):
 *   1. requireAgentAuth — invalid/expired token → 401
 *   2. ctx.capabilities.products_lookup === true — missing flag → 403 (no query runs)
 *   3. db.forOrg(orgId) — cross-org rows are auto-excluded
 *
 * Query param: ?q=<term> optional name filter (case-insensitive).
 */
import { and, eq, ilike } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { productsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  // Capability gate — check before ANY DB query.
  if (ctx.capabilities.products_lookup !== true) {
    return NextResponse.json(
      { error: 'Channel does not have products_lookup capability' },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() || '';

  const { organizationId } = ctx;

  // Build the base filter: not deleted. The tenant-db proxy will AND the org filter.
  const baseFilter = q
    ? and(eq(productsSchema.deleted, false), ilike(productsSchema.name, `%${q}%`))
    : eq(productsSchema.deleted, false);

  const products = await db
    .forOrg(organizationId)
    .select({
      id: productsSchema.id,
      name: productsSchema.name,
      price: productsSchema.price,
      stock: productsSchema.stock,
    })
    .from(productsSchema)
    .where(baseFilter!);

  return NextResponse.json(
    products.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      stock: p.stock,
    })),
  );
}
