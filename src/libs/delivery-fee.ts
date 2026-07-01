import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { appSettingsSchema } from '@/models/Schema';

// Delivery fee configuration, org-scoped, stored in `app_settings` (same
// mechanism as returns policy / e-invoicing / transfer toggles — see
// libs/return-policy.ts, libs/einvoice/config.ts, libs/transfer-reconciliation.ts).
//
// Configured in Ajustes → Módulos → Domicilios. The fee is ALWAYS computed
// server-side by computeDeliveryFee() from this config plus the REAL subtotal
// (real product prices re-fetched from db.forOrg). Callers — including the
// WhatsApp/n8n agent — never supply price or fee directly; see
// POST /api/agent/deliveries and POST /api/agent/deliveries/quote.

export const DELIVERY_FEE_TYPE_KEY = 'delivery_fee_type';
export const DELIVERY_FEE_VALUE_KEY = 'delivery_fee_value';
export const DELIVERY_FREE_ABOVE_KEY = 'delivery_free_above';

export type DeliveryFeeType = 'none' | 'fixed' | 'percent';

export type DeliveryFeeConfig = {
  type: DeliveryFeeType;
  /** Fixed amount (type='fixed') or percentage points (type='percent', e.g. 10 = 10%). */
  value: number;
  /** Subtotal threshold at/above which shipping is free. null = no threshold configured. */
  freeAbove: number | null;
};

/** Unconfigured org: no delivery fee is ever charged. */
export const DEFAULT_DELIVERY_FEE_CONFIG: DeliveryFeeConfig = {
  type: 'none',
  value: 0,
  freeAbove: null,
};

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Parses a stored setting into a non-negative finite number, or null if invalid/absent. */
function parseNonNegative(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Reads the delivery fee configuration for an organization. Missing or
 * invalid stored values fall back to DEFAULT_DELIVERY_FEE_CONFIG piece by
 * piece (an unconfigured org charges no delivery fee at all).
 */
export async function getDeliveryFeeConfig(
  executor: Executor,
  organizationId: string,
): Promise<DeliveryFeeConfig> {
  const rows = await executor
    .select({ key: appSettingsSchema.key, value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        inArray(appSettingsSchema.key, [
          DELIVERY_FEE_TYPE_KEY,
          DELIVERY_FEE_VALUE_KEY,
          DELIVERY_FREE_ABOVE_KEY,
        ]),
      ),
    );
  const map = new Map(rows.map(r => [r.key, r.value]));

  const rawType = map.get(DELIVERY_FEE_TYPE_KEY);
  const type: DeliveryFeeType
    = rawType === 'fixed' || rawType === 'percent' ? rawType : 'none';

  const value = parseNonNegative(map.get(DELIVERY_FEE_VALUE_KEY)) ?? 0;
  const freeAbove = parseNonNegative(map.get(DELIVERY_FREE_ABOVE_KEY));

  return { type, value, freeAbove };
}

/**
 * Pure, deterministic delivery fee calculation — the ONLY place the shipping
 * amount is computed. Callers (including the LLM/agent) never set this value
 * directly; it is always derived from the org's config + the real subtotal.
 */
export function computeDeliveryFee(
  config: DeliveryFeeConfig,
  subtotal: number,
): number {
  if (config.type === 'none') {
    return 0;
  }
  if (config.freeAbove !== null && subtotal >= config.freeAbove) {
    return 0;
  }
  if (config.type === 'fixed') {
    return config.value;
  }
  // type === 'percent'
  return Math.round(subtotal * (config.value / 100));
}

/**
 * Route-facing convenience wrapper: resolves the org's config from the real
 * DB and returns the computed fee for a subtotal in one call.
 *
 * Deliberately takes only `organizationId` (no executor param) so API route
 * handlers under src/app/api never need to import the raw `@/libs/DB`
 * themselves — see libs/tenant-isolation-guard.test.ts, which fails the build
 * if a route file imports `@/libs/DB` directly. This module lives outside
 * src/app/api and is the audited, single place that touches the raw db for
 * delivery-fee reads.
 */
export async function resolveDeliveryFee(
  organizationId: string,
  subtotal: number,
): Promise<number> {
  const config = await getDeliveryFeeConfig(db, organizationId);
  return computeDeliveryFee(config, subtotal);
}
