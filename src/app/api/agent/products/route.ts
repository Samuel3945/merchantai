import type { Candidate } from '@/features/products/search/ranking';
/**
 * GET /api/agent/products
 *
 * Capability-gated product search for the n8n delivery agent. Price and stock
 * ALWAYS come from db.forOrg — LLM-supplied values are never used.
 *
 * Guards (in order):
 *   1. requireAgentAuth — invalid/expired token → 401
 *   2. ctx.capabilities.products_lookup === true — missing flag → 403 (no query runs)
 *   3. db.forOrg(orgId) — cross-org rows are auto-excluded
 *
 * Query params:
 *   ?q=<term>      search term (name, barcode, or fuzzy/FTS match).
 *   ?limit=<n>     max results, default 5, clamped to [1, 25].
 *
 * The candidate query combines trigram similarity + spanish FTS + exact
 * barcode match (see migrations/0077_product_search_trgm_fts.sql for the
 * supporting `immutable_unaccent`/index infrastructure); rankAndDecide (pure,
 * src/features/products/search/ranking.ts) then classifies/sorts/ranks in
 * TypeScript and decides the response status.
 */
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { normalizeQuery } from '@/features/products/search/normalize';
import { rankAndDecide } from '@/features/products/search/ranking';
import { expandQueries } from '@/features/products/search/synonyms';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { productsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
const CANDIDATE_POOL = 60;

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

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
  const limit = parseLimit(url.searchParams.get('limit'));

  if (!q) {
    return NextResponse.json({
      status: 'not_found',
      query: '',
      normalized: '',
      results: [],
      alternatives: [],
      clarification: { needed: false, reason: null, options: [] },
      meta: { candidates: 0, returned: 0, limit },
    });
  }

  const { organizationId } = ctx;
  const nq = normalizeQuery(q);
  const trimmedQ = q.trim();

  // Recall = trigram (typos) + spanish FTS (vocabulary) + exact barcode. The FTS
  // side is OR'd over the query AND its ES-CO synonyms, so "gaseosa" also finds
  // "refresco". Trigram + sim stay on the literal query (typo tolerance).
  const ftsVector = sql`to_tsvector('spanish', immutable_unaccent(${productsSchema.name} || ' ' || coalesce(${productsSchema.category}, '')))`;
  const ftsQuery = sql.join(
    expandQueries(nq).map(term => sql`plainto_tsquery('spanish', ${term})`),
    sql` || `,
  );

  const rows = await db
    .forOrg(organizationId)
    .select({
      id: productsSchema.id,
      name: productsSchema.name,
      price: productsSchema.price,
      stock: productsSchema.stock,
      category: productsSchema.category,
      unitType: productsSchema.unitType,
      barcode: productsSchema.barcode,
      sim: sql<number>`similarity(immutable_unaccent(${productsSchema.name}), ${nq})`.as('sim'),
      ftsRank: sql<number>`ts_rank(${ftsVector}, (${ftsQuery}))`.as('fts_rank'),
    })
    .from(productsSchema)
    .where(sql`${productsSchema.deleted} = false AND ${productsSchema.status} = 'published' AND ( immutable_unaccent(${productsSchema.name}) % ${nq} OR ${ftsVector} @@ (${ftsQuery}) OR (${productsSchema.barcode} IS NOT NULL AND ${productsSchema.barcode} = ${trimmedQ}) )`)
    .limit(CANDIDATE_POOL);

  const candidates: Candidate[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    price: row.price,
    stock: Number(row.stock),
    category: row.category,
    unitType: row.unitType,
    barcode: row.barcode,
    sim: Number(row.sim),
    ftsRank: Number(row.ftsRank),
  }));

  return NextResponse.json(rankAndDecide(q, candidates, limit));
}
