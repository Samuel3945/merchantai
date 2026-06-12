import type { db } from '@/libs/DB';
import { and, eq, inArray } from 'drizzle-orm';
import { appSettingsSchema } from '@/models/Schema';

// Return rules configured in Ajustes → Devoluciones. Enforced inside
// applySaleReturn (single choke point for the web panel and the POS), and read
// by the UIs to disable the action up front.

export const RETURN_DEFAULT_MAX_DAYS = 7;

export type ReturnPolicy = {
  enabled: boolean;
  /** Days after the sale during which a return is accepted. */
  maxDays: number;
  /** When true, only an organization admin may process returns. */
  requireAdmin: boolean;
};

type Executor = Pick<typeof db, 'select'>;

export async function loadReturnPolicy(
  executor: Executor,
  organizationId: string,
): Promise<ReturnPolicy> {
  const rows = await executor
    .select({ key: appSettingsSchema.key, value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        inArray(appSettingsSchema.key, [
          'returns_enabled',
          'returns_max_days',
          'returns_require_admin',
        ]),
      ),
    );
  const map = new Map(rows.map(r => [r.key, r.value]));

  const maxDaysRaw = Number.parseInt(map.get('returns_max_days') ?? '', 10);
  return {
    enabled: map.get('returns_enabled') !== 'false',
    maxDays:
      Number.isFinite(maxDaysRaw) && maxDaysRaw >= 0
        ? maxDaysRaw
        : RETURN_DEFAULT_MAX_DAYS,
    requireAdmin: map.get('returns_require_admin') === 'true',
  };
}

/** Whole days elapsed since the sale, in real time. */
export function daysSinceSale(soldAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - soldAt.getTime()) / 86400000);
}

export function isWithinReturnWindow(
  policy: ReturnPolicy,
  soldAt: Date,
  now: Date = new Date(),
): boolean {
  return daysSinceSale(soldAt, now) <= policy.maxDays;
}

/**
 * Throws with a cashier-readable Spanish message when the return is not
 * allowed by the business rules. `isAdmin` is true for the org owner acting
 * from the web panel; POS cashiers are never admins.
 */
export function assertReturnAllowed(
  policy: ReturnPolicy,
  soldAt: Date,
  opts: { isAdmin: boolean },
  now: Date = new Date(),
): void {
  if (!policy.enabled) {
    throw new Error('Las devoluciones están desactivadas en Ajustes.');
  }
  if (!isWithinReturnWindow(policy, soldAt, now)) {
    throw new Error(
      `Esta venta supera el plazo de devolución (${policy.maxDays} días).`,
    );
  }
  if (policy.requireAdmin && !opts.isAdmin) {
    throw new Error(
      'Las devoluciones requieren autorización del administrador. Pídele que la procese desde el panel web.',
    );
  }
}
