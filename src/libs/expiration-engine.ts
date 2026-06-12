// Smart Stock expiration engine ("Gerenta IA").
//
// For each open entry batch with expires_at:
//   daysToExpire = expires_at - today
//   daysToSell   = remainingQty / avgDaily
//   riskRatio    = daysToSell / daysToExpire
//   tier         = riskRatio < 0.6 ? 'atencion' : <0.9 ? 'urgente' : 'critico'
//   maxSafePct   = (1 - unitCost / salePrice) * 100   (discount without losing money)
//   suggestedPct = min(tierEscalation[tier], maxSafePct)  (10 / 20 / 35)
//
// avgDaily uses a fixed 30-day window of sale_items qty for the product. Simple
// and self-contained; we can swap to EWMA later if needed.
//
// Side effects per batch:
//   1. UPSERT expiration_risk_cache.
//   2. If tier escalated vs. last suggestion OR ≥3 days since last rejection
//      (max 3 reopens), open a new 'pending' expiration_suggestion.

import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import {
  expirationRiskCacheSchema,
  expirationSuggestionsSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

export type ExpirationTier = 'atencion' | 'urgente' | 'critico';

export type ExpirationRiskPayload = {
  /** null = batch has an expiry date but no actionable risk yet. */
  tier: ExpirationTier | null;
  riskRatio: number | null;
  daysToExpire: number;
  daysToSell: number | null;
  remainingQty: number;
  avgDaily: number;
  unitCost: number;
  salePrice: number;
  suggestedPct: number;
  suggestedPrice: number;
  maxSafePct: number;
  reasoning: string;
  classificationSource: 'engine_v1';
};

const TIER_PCT: Record<ExpirationTier, number> = {
  atencion: 10,
  urgente: 20,
  critico: 35,
};

const TIER_ORDER: Record<ExpirationTier, number> = {
  atencion: 1,
  urgente: 2,
  critico: 3,
};

const CACHE_TTL_HOURS = 24;
const SALES_WINDOW_DAYS = 30;
const REJECT_COOLDOWN_DAYS = 3;
const MAX_REOPEN_COUNT = 3;

// Beyond this horizon nothing is flagged: the engine recomputes daily, so a
// far-out batch will be caught when it actually approaches risk. Prevents a
// product expiring in 15 months from showing orange "Por vencer" today.
const RISK_HORIZON_DAYS = 120;

// A LOW riskRatio (daysToSell / daysToExpire) means the lot sells out long
// before expiry — that's NO risk. Risk starts when the sell-out time eats into
// the time left (>= 0.5) and is critical when it won't sell out at all (>= 1).
// With no sales velocity the ratio is meaningless, so fall back to plain
// date proximity.
export function classifyTier(
  riskRatio: number | null,
  daysToExpire: number,
): ExpirationTier | null {
  if (daysToExpire > RISK_HORIZON_DAYS) {
    return null;
  }
  if (riskRatio === null) {
    if (daysToExpire <= 7) {
      return 'critico';
    }
    if (daysToExpire <= 15) {
      return 'urgente';
    }
    if (daysToExpire <= 30) {
      return 'atencion';
    }
    return null;
  }
  if (riskRatio >= 1) {
    return 'critico';
  }
  if (riskRatio >= 0.75) {
    return 'urgente';
  }
  if (riskRatio >= 0.5) {
    return 'atencion';
  }
  // Selling fast enough — but a batch in its final week always deserves a look.
  return daysToExpire <= 7 ? 'atencion' : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

type RecomputeBatchInput = {
  organizationId: string;
  movementId: string;
  productId: string;
  remainingQty: number;
  unitCost: number;
  salePrice: number;
  expiresAt: Date;
  avgDaily: number;
  now: Date;
};

function buildPayload(input: RecomputeBatchInput): ExpirationRiskPayload {
  const { remainingQty, unitCost, salePrice, expiresAt, avgDaily, now } = input;

  const daysToExpire = Math.max(daysBetween(now, expiresAt), 0);
  const daysToSell = avgDaily > 0 ? remainingQty / avgDaily : null;
  const riskRatio
    = daysToSell !== null && daysToExpire > 0
      ? daysToSell / daysToExpire
      : null;

  const tier = classifyTier(riskRatio, daysToExpire);

  const maxSafePct
    = salePrice > 0 ? Math.max(0, (1 - unitCost / salePrice) * 100) : 0;
  const escalation = tier ? TIER_PCT[tier] : 0;
  const suggestedPct = Math.min(escalation, maxSafePct);
  const suggestedPrice = round2(salePrice * (1 - suggestedPct / 100));

  const reasoning
    = tier === 'critico'
      ? `Quedan ${daysToExpire}d para vencer y se venden ~${avgDaily.toFixed(1)}/día (≈${daysToSell?.toFixed(1) ?? '∞'}d para liquidar). Descuento ${suggestedPct.toFixed(0)}% para no perder el lote.`
      : tier === 'urgente'
        ? `Ritmo de venta no alcanza: ${daysToSell?.toFixed(1) ?? '∞'}d necesarios vs ${daysToExpire}d disponibles. Aplica ${suggestedPct.toFixed(0)}% de descuento.`
        : tier === 'atencion'
          ? `Margen aún cómodo, pero conviene empujar: ${suggestedPct.toFixed(0)}% acelera salida sin perder dinero (tope seguro ${maxSafePct.toFixed(0)}%).`
          : `Sin riesgo: vence en ${daysToExpire}d y el ritmo de venta lo cubre de sobra.`;

  return {
    tier,
    riskRatio:
      riskRatio !== null && Number.isFinite(riskRatio)
        ? round2(riskRatio)
        : null,
    daysToExpire,
    daysToSell: daysToSell !== null ? round2(daysToSell) : null,
    remainingQty,
    avgDaily: round2(avgDaily),
    unitCost: round2(unitCost),
    salePrice: round2(salePrice),
    suggestedPct: round2(suggestedPct),
    suggestedPrice,
    maxSafePct: round2(maxSafePct),
    reasoning,
    classificationSource: 'engine_v1',
  };
}

async function computeAvgDaily(
  organizationId: string,
  productId: string,
  now: Date,
): Promise<number> {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - SALES_WINDOW_DAYS);

  const [row] = await db
    .select({
      total: sql<string | null>`COALESCE(SUM(${saleItemsSchema.qty}), 0)`,
    })
    .from(saleItemsSchema)
    .innerJoin(salesSchema, eq(salesSchema.id, saleItemsSchema.saleId))
    .where(
      and(
        eq(saleItemsSchema.productId, productId),
        eq(salesSchema.organizationId, organizationId),
        gt(salesSchema.createdAt, since),
      ),
    );

  const total = Number(row?.total ?? 0);
  return total / SALES_WINDOW_DAYS;
}

async function shouldOpenSuggestion(
  organizationId: string,
  movementId: string,
  newTier: ExpirationTier,
  now: Date,
): Promise<{ open: boolean; reason: 'first' | 'escalated' | 'cooldown'; reopenCount: number } | null> {
  const [last] = await db
    .select()
    .from(expirationSuggestionsSchema)
    .where(
      and(
        eq(expirationSuggestionsSchema.organizationId, organizationId),
        eq(expirationSuggestionsSchema.movementId, movementId),
      ),
    )
    .orderBy(desc(expirationSuggestionsSchema.createdAt))
    .limit(1);

  if (!last) {
    return { open: true, reason: 'first', reopenCount: 0 };
  }

  // A pending suggestion is already visible — don't double-open.
  if (last.status === 'pending') {
    return null;
  }

  // Tier escalated since the previous suggestion → always reopen (still bounded
  // by max reopen count below).
  if (TIER_ORDER[newTier] > TIER_ORDER[last.tier]) {
    if (last.reopenCount >= MAX_REOPEN_COUNT) {
      return null;
    }
    return { open: true, reason: 'escalated', reopenCount: last.reopenCount + 1 };
  }

  // Same/lower tier: only reopen for rejected suggestions after cooldown.
  if (last.status === 'rejected') {
    if (last.reopenCount >= MAX_REOPEN_COUNT) {
      return null;
    }
    const resolvedAt = last.resolvedAt ?? last.createdAt;
    const days = daysBetween(resolvedAt, now);
    if (days >= REJECT_COOLDOWN_DAYS) {
      return { open: true, reason: 'cooldown', reopenCount: last.reopenCount + 1 };
    }
  }

  return null;
}

async function processBatch(
  organizationId: string,
  movement: {
    id: string;
    productId: string;
    remainingQty: number | null;
    unitCost: string | null;
    expiresAt: string | Date;
  },
  product: { price: string },
  now: Date,
): Promise<{ tier: ExpirationTier | null; opened: boolean } | null> {
  const remainingQty = movement.remainingQty ?? 0;
  if (remainingQty <= 0) {
    return null;
  }

  const expiresAt
    = movement.expiresAt instanceof Date
      ? movement.expiresAt
      : new Date(`${movement.expiresAt}T00:00:00Z`);

  // Skip already-expired batches; the cleanup of expired suggestions is handled
  // separately by status='expired' transitions, not by re-firing the engine.
  if (expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const unitCost = Number(movement.unitCost ?? 0);
  const salePrice = Number(product.price ?? 0);
  const avgDaily = await computeAvgDaily(organizationId, movement.productId, now);

  const payload = buildPayload({
    organizationId,
    movementId: movement.id,
    productId: movement.productId,
    remainingQty,
    unitCost,
    salePrice,
    expiresAt,
    avgDaily,
    now,
  });

  const cacheExpiresAt = new Date(now);
  cacheExpiresAt.setUTCHours(cacheExpiresAt.getUTCHours() + CACHE_TTL_HOURS);

  await db
    .insert(expirationRiskCacheSchema)
    .values({
      organizationId,
      movementId: movement.id,
      productId: movement.productId,
      payload,
      computedAt: now,
      expiresAt: cacheExpiresAt,
    })
    .onConflictDoUpdate({
      target: [
        expirationRiskCacheSchema.organizationId,
        expirationRiskCacheSchema.movementId,
      ],
      set: {
        productId: movement.productId,
        payload,
        computedAt: now,
        expiresAt: cacheExpiresAt,
      },
    });

  // No actionable risk: keep the cache row fresh (so the UI shows nothing) and
  // resolve any pending suggestion that no longer applies.
  if (payload.tier === null) {
    await db
      .update(expirationSuggestionsSchema)
      .set({ status: 'superseded', resolvedAt: now })
      .where(
        and(
          eq(expirationSuggestionsSchema.organizationId, organizationId),
          eq(expirationSuggestionsSchema.movementId, movement.id),
          eq(expirationSuggestionsSchema.status, 'pending'),
        ),
      );
    return { tier: null, opened: false };
  }

  // Narrowed copy: TS can't carry payload.tier's null check into the closure.
  const activeTier = payload.tier;

  const decision = await shouldOpenSuggestion(
    organizationId,
    movement.id,
    activeTier,
    now,
  );

  if (!decision) {
    return { tier: activeTier, opened: false };
  }

  await db.transaction(async (tx) => {
    // Supersede any prior non-terminal suggestion for the same batch.
    await tx
      .update(expirationSuggestionsSchema)
      .set({ status: 'superseded', resolvedAt: now })
      .where(
        and(
          eq(expirationSuggestionsSchema.organizationId, organizationId),
          eq(expirationSuggestionsSchema.movementId, movement.id),
          eq(expirationSuggestionsSchema.status, 'pending'),
        ),
      );

    await tx.insert(expirationSuggestionsSchema).values({
      organizationId,
      movementId: movement.id,
      productId: movement.productId,
      tier: activeTier,
      suggestedPct: payload.suggestedPct.toFixed(2),
      maxSafePct: payload.maxSafePct.toFixed(2),
      suggestedPrice: payload.suggestedPrice.toFixed(2),
      basePrice: payload.salePrice.toFixed(2),
      unitCost: payload.unitCost.toFixed(2),
      reasoning: payload.reasoning,
      status: 'pending',
      reopenCount: decision.reopenCount,
      meta: { reason: decision.reason, source: 'engine_v1' },
    });
  });

  return { tier: activeTier, opened: true };
}

export type RecomputeResult = {
  scannedBatches: number;
  cached: number;
  suggestionsOpened: number;
};

export async function recomputeAll(now: Date = new Date()): Promise<RecomputeResult> {
  const rows = await db
    .select({
      movement: stockMovementsSchema,
      product: productsSchema,
    })
    .from(stockMovementsSchema)
    .innerJoin(
      productsSchema,
      eq(productsSchema.id, stockMovementsSchema.productId),
    )
    .where(
      and(
        eq(stockMovementsSchema.type, 'entry'),
        eq(productsSchema.isPerishable, true),
        eq(productsSchema.deleted, false),
        isNotNull(stockMovementsSchema.expiresAt),
        gt(stockMovementsSchema.remainingQty, 0),
      ),
    );

  let cached = 0;
  let opened = 0;
  for (const { movement, product } of rows) {
    const result = await processBatch(
      movement.organizationId,
      {
        id: movement.id,
        productId: movement.productId,
        remainingQty: movement.remainingQty,
        unitCost: movement.unitCost,
        expiresAt: movement.expiresAt as unknown as string,
      },
      { price: product.price },
      now,
    );
    if (result) {
      cached += 1;
      if (result.opened) {
        opened += 1;
      }
    }
  }

  return { scannedBatches: rows.length, cached, suggestionsOpened: opened };
}
