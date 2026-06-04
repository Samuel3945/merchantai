import { sql } from 'drizzle-orm';
import {
  CASH_SECURITY_POLICY,
  inflowMultiplier,
} from '@/libs/cash-security-policy';
import { db } from '@/libs/DB';
import { cashSecurityThresholdCacheSchema } from '@/models/Schema';

type RawDb = typeof db;

export type CashThresholdComputation = {
  threshold: number;
  avgDailyInflow: number;
  accumulatedP85: number;
  daysOperated: number;
  /** Which signal won, for the explainable payload. */
  drivenBy: 'inflow' | 'accumulated';
  reasoning: string;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function intVal(v: unknown): number {
  const n = Number.parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Behavioural cash-security threshold for one organization, derived from its
 * recent cash history. Two signals (see cash-security-policy):
 *   A — daily intake rhythm: avg daily cash inflow × band multiplier.
 *   B — habitual standing cash: p85 of end-of-day cash × safety factor.
 * threshold = max(A, B) so both a constant-withdrawer (low B → A wins) and a
 * multi-day accumulator (high B → B wins) are handled without manual config.
 */
export async function computeCashThreshold(
  orgId: string,
  executor: RawDb = db,
): Promise<CashThresholdComputation> {
  const { lookbackDays, accumulatedPercentile, accumulatedSafetyFactor }
    = CASH_SECURITY_POLICY;

  // Signal A — average daily cash inflow across the operated days in the window.
  const inflowRes = await executor.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type IN ('sale','deposit','adjustment')), 0)::float8 AS inflow,
      COUNT(DISTINCT (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date)::int AS days_operated
    FROM cash_movements
    WHERE organization_id = ${orgId}
      AND created_at >= now() - (${lookbackDays}::text || ' days')::interval
  `);
  const ai = (inflowRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const daysOperated = intVal(ai.days_operated);
  const avgDailyInflow = daysOperated > 0 ? num(ai.inflow) / daysOperated : 0;

  // Signal B — p85 of the cash the org typically ends the day with (closed
  // sessions in the window).
  const accRes = await executor.execute(sql`
    SELECT COALESCE(
      percentile_cont(${accumulatedPercentile}) WITHIN GROUP (
        ORDER BY GREATEST(COALESCE(expected_amount, 0)::float8, 0)
      ), 0
    )::float8 AS p85
    FROM cash_sessions
    WHERE organization_id = ${orgId}
      AND status = 'closed'
      AND closed_at >= now() - (${lookbackDays}::text || ' days')::interval
  `);
  const ab = (accRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const accumulatedP85 = num(ab.p85);

  const inflowBase = avgDailyInflow * inflowMultiplier(avgDailyInflow);
  const accumulatedBase = accumulatedP85 * accumulatedSafetyFactor;
  const threshold = Math.max(inflowBase, accumulatedBase);
  const drivenBy = accumulatedBase > inflowBase ? 'accumulated' : 'inflow';

  const reasoning
    = drivenBy === 'accumulated'
      ? 'Umbral según tu nivel habitual de efectivo al cierre (acumulás varios días).'
      : 'Umbral según el ritmo de efectivo que entra por día.';

  return {
    threshold,
    avgDailyInflow,
    accumulatedP85,
    daysOperated,
    drivenBy,
    reasoning,
  };
}

/** Computes the threshold and UPSERTs it into the per-org cache. */
export async function recomputeAndCacheCashThreshold(
  orgId: string,
  executor: RawDb = db,
): Promise<CashThresholdComputation> {
  const c = await computeCashThreshold(orgId, executor);

  const values = {
    organizationId: orgId,
    threshold: c.threshold.toFixed(2),
    avgDailyInflow: c.avgDailyInflow.toFixed(2),
    accumulatedP85: c.accumulatedP85.toFixed(2),
    daysOperated: c.daysOperated,
    payload: {
      drivenBy: c.drivenBy,
      reasoning: c.reasoning,
      inflowBase: Number((c.avgDailyInflow * inflowMultiplier(c.avgDailyInflow)).toFixed(2)),
      accumulatedBase: Number(
        (c.accumulatedP85 * CASH_SECURITY_POLICY.accumulatedSafetyFactor).toFixed(2),
      ),
    },
    computedAt: new Date(),
  };

  await executor
    .insert(cashSecurityThresholdCacheSchema)
    .values(values)
    .onConflictDoUpdate({
      target: cashSecurityThresholdCacheSchema.organizationId,
      set: {
        threshold: values.threshold,
        avgDailyInflow: values.avgDailyInflow,
        accumulatedP85: values.accumulatedP85,
        daysOperated: values.daysOperated,
        payload: values.payload,
        computedAt: values.computedAt,
      },
    });

  return c;
}
