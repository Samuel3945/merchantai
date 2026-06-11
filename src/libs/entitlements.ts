import { auth } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import {
  planEntitlementsSchema,
  plansSchema,
  subscriptionsSchema,
} from '@/models/Schema';

/**
 * Entitlements resolver — the single answer to "what is this org allowed to
 * do?". Resolution chain: active subscription → plan catalog row → entitlement
 * rows. Replaces the hardcoded PLAN_* maps that used to live in
 * actions/plans.ts, actions/pos-tokens.ts and actions/employees.ts, and the
 * never-written `organization_plans` table those last two read (which silently
 * kept paying orgs on free-tier cashier limits).
 *
 * Known keys (operators can add more from the platform console):
 *   max_cashiers, max_pos_devices,
 *   ai_credits_sales_manager, ai_credits_customer_service,
 *   feature_smart_stock (0/1)
 */

export type OrgEntitlements = {
  planSlug: string;
  planName: string;
  limits: Record<string, number>;
};

// Last-resort free-tier equivalents so a misconfigured or empty catalog can
// never crash tenant flows or grant unlimited quota.
const FALLBACK_ENTITLEMENTS: OrgEntitlements = {
  planSlug: 'free',
  planName: 'Gratis',
  limits: {
    max_cashiers: 1,
    max_pos_devices: 1,
    ai_credits_sales_manager: 0,
    ai_credits_customer_service: 0,
    feature_smart_stock: 0,
  },
};

async function loadPlanWithEntitlements(
  planRow: { id: string; slug: string; name: string },
): Promise<OrgEntitlements> {
  const rows = await db
    .select({
      key: planEntitlementsSchema.key,
      value: planEntitlementsSchema.value,
    })
    .from(planEntitlementsSchema)
    .where(eq(planEntitlementsSchema.planId, planRow.id));

  const limits: Record<string, number> = {};
  for (const row of rows) {
    limits[row.key] = row.value;
  }

  return { planSlug: planRow.slug, planName: planRow.name, limits };
}

/**
 * Resolves a plan by slug, including archived plans so orgs grandfathered on
 * a retired plan keep their limits. Returns null for unknown slugs.
 */
export async function getPlanEntitlementsBySlug(
  slug: string,
): Promise<OrgEntitlements | null> {
  const [plan] = await db
    .select({
      id: plansSchema.id,
      slug: plansSchema.slug,
      name: plansSchema.name,
    })
    .from(plansSchema)
    .where(eq(plansSchema.slug, slug))
    .limit(1);

  if (!plan) {
    return null;
  }
  return loadPlanWithEntitlements(plan);
}

async function getDefaultPlanEntitlements(): Promise<OrgEntitlements> {
  const [plan] = await db
    .select({
      id: plansSchema.id,
      slug: plansSchema.slug,
      name: plansSchema.name,
    })
    .from(plansSchema)
    .where(eq(plansSchema.isDefault, true))
    .limit(1);

  if (!plan) {
    return FALLBACK_ENTITLEMENTS;
  }
  return loadPlanWithEntitlements(plan);
}

/** Effective entitlements for an org: active subscription plan, or default. */
export async function getOrgEntitlements(
  orgId: string,
): Promise<OrgEntitlements> {
  const [active] = await db
    .select({ plan: subscriptionsSchema.plan })
    .from(subscriptionsSchema)
    .where(
      and(
        eq(subscriptionsSchema.organizationId, orgId),
        eq(subscriptionsSchema.active, true),
      ),
    )
    .orderBy(desc(subscriptionsSchema.createdAt))
    .limit(1);

  if (active) {
    const bySlug = await getPlanEntitlementsBySlug(active.plan);
    if (bySlug) {
      return bySlug;
    }
  }
  return getDefaultPlanEntitlements();
}

/** Entitlements for the Clerk session org. Throws without an active org. */
export async function getCurrentOrgEntitlements(): Promise<OrgEntitlements> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No active organization');
  }
  return getOrgEntitlements(orgId);
}

/** Numeric limit with an explicit fallback for keys missing on the plan. */
export function limitOf(
  entitlements: OrgEntitlements,
  key: string,
  fallback = 0,
): number {
  return entitlements.limits[key] ?? fallback;
}

/** Boolean feature gate: any value >= 1 grants the feature. */
export function hasFeature(
  entitlements: OrgEntitlements,
  key: string,
): boolean {
  return (entitlements.limits[key] ?? 0) >= 1;
}
