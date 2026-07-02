'use server';

import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { poolLimitForPlan } from '@/libs/entitlements';
import { Env } from '@/libs/Env';
import { findPackage } from '@/libs/topup-catalog';
import { buildCheckoutUrl } from '@/libs/wompi/client';
import { integritySignature } from '@/libs/wompi/signature';
import {
  plansSchema,
  subscriptionsSchema,
  topUpsSchema,
  usageCountersSchema,
} from '@/models/Schema';

// Plan identity is the catalog slug ('free', 'pro', ...). The catalog lives in
// the `plans` table and is operator-managed, so this is intentionally an open
// string instead of a closed union.
export type PlanName = string;

// usage_counters is now a single row per org (the shared credit pool); this
// is the constant agent_kind value that row is stored under. See migration
// 0082_unify_credit_pool.
const POOL_AGENT_KIND = 'pool';

// The plan an org sits on without an active subscription row.
async function getDefaultPlanSlug(): Promise<string> {
  const [row] = await db
    .select({ slug: plansSchema.slug })
    .from(plansSchema)
    .where(eq(plansSchema.isDefault, true))
    .limit(1);
  return row?.slug ?? 'free';
}

export type CurrentPlan = {
  plan: PlanName;
  // Display name from the catalog; falls back to the slug for unknown plans.
  planName: string;
  active: boolean;
  periodStart: string | null;
  periodEnd: string | null;
};

// Catalog entry as shown to tenants (public, non-archived plans only).
export type PublicPlan = {
  slug: string;
  name: string;
  description: string | null;
  priceMonthlyCop: number;
  priceAnnualCop: number | null;
  featureBullets: string[];
};

// The live plan catalog for tenant-facing pages (plans page, onboarding).
export async function listPublicPlans(): Promise<PublicPlan[]> {
  const rows = await db
    .select()
    .from(plansSchema)
    .where(
      and(eq(plansSchema.isPublic, true), eq(plansSchema.isArchived, false)),
    )
    .orderBy(asc(plansSchema.sortOrder), asc(plansSchema.createdAt));

  return rows.map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    priceMonthlyCop: Number(p.priceMonthlyCop),
    priceAnnualCop: p.priceAnnualCop === null ? null : Number(p.priceAnnualCop),
    featureBullets: p.featureBullets,
  }));
}

export type PoolBalance = {
  used: number;
  monthlyLimit: number;
  toppedUp: number;
  remaining: number;
  resetAt: string | null;
};

export type PlanSnapshot = {
  subscription: CurrentPlan;
  pool: PoolBalance;
};

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage the plan');
  }
  return { userId, orgId };
}

async function ensureCountersForPlan(orgId: string, plan: PlanName) {
  const monthlyLimit = await poolLimitForPlan(plan);
  await db
    .insert(usageCountersSchema)
    .values({
      organizationId: orgId,
      agentKind: POOL_AGENT_KIND,
      used: 0,
      monthlyLimit,
      toppedUp: 0,
    })
    .onConflictDoNothing({
      target: [usageCountersSchema.organizationId],
    });
}

async function readPool(orgId: string): Promise<PoolBalance> {
  const [row] = await db
    .select()
    .from(usageCountersSchema)
    .where(eq(usageCountersSchema.organizationId, orgId))
    .limit(1);

  const used = row?.used ?? 0;
  const monthlyLimit = row?.monthlyLimit ?? 0;
  const toppedUp = row?.toppedUp ?? 0;
  return {
    used,
    monthlyLimit,
    toppedUp,
    remaining: Math.max(0, monthlyLimit + toppedUp - used),
    resetAt: row?.resetAt ? row.resetAt.toISOString() : null,
  };
}

export async function currentPlan(): Promise<PlanSnapshot> {
  const { orgId } = await requireOrg();

  const [active] = await db
    .select()
    .from(subscriptionsSchema)
    .where(
      and(
        eq(subscriptionsSchema.organizationId, orgId),
        eq(subscriptionsSchema.active, true),
      ),
    )
    .orderBy(desc(subscriptionsSchema.createdAt))
    .limit(1);

  const plan: PlanName = active ? active.plan : await getDefaultPlanSlug();

  await ensureCountersForPlan(orgId, plan);

  const pool = await readPool(orgId);

  const [planRow] = await db
    .select({ name: plansSchema.name })
    .from(plansSchema)
    .where(eq(plansSchema.slug, plan))
    .limit(1);

  return {
    subscription: {
      plan,
      planName: planRow?.name ?? plan,
      active: active ? active.active : true,
      periodStart: active?.periodStart
        ? active.periodStart.toISOString()
        : null,
      periodEnd: active?.periodEnd ? active.periodEnd.toISOString() : null,
    },
    pool,
  };
}

export async function upgradePlan(plan: PlanName): Promise<PlanSnapshot> {
  // Tenant-facing upgrade: only live, publicly offered catalog plans are
  // selectable. Hidden/archived plans are operator-assigned from /platform.
  const [planRow] = await db
    .select({
      isPublic: plansSchema.isPublic,
      isArchived: plansSchema.isArchived,
    })
    .from(plansSchema)
    .where(eq(plansSchema.slug, plan))
    .limit(1);
  if (!planRow || planRow.isArchived || !planRow.isPublic) {
    throw new Error(`Unknown plan: ${String(plan)}`);
  }
  const { userId, orgId } = await requireAdminOrg();

  const previousPlan = await getActivePlan(orgId);

  const monthlyLimit = await poolLimitForPlan(plan);

  // One atomic swap: deactivate the old subscription, activate the new one and
  // reset the pool together. A crash between these steps would otherwise
  // leave the org with zero active subscriptions (silently on the free tier) or
  // with the new plan but the old quota.
  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionsSchema)
      .set({ active: false })
      .where(
        and(
          eq(subscriptionsSchema.organizationId, orgId),
          eq(subscriptionsSchema.active, true),
        ),
      );

    await tx.insert(subscriptionsSchema).values({
      organizationId: orgId,
      plan,
      active: true,
    });

    const inserted = await tx
      .insert(usageCountersSchema)
      .values({
        organizationId: orgId,
        agentKind: POOL_AGENT_KIND,
        used: 0,
        monthlyLimit,
        toppedUp: 0,
      })
      .onConflictDoNothing({
        target: [usageCountersSchema.organizationId],
      })
      .returning({ id: usageCountersSchema.id });

    if (inserted.length === 0) {
      await tx
        .update(usageCountersSchema)
        .set({ used: 0, monthlyLimit, toppedUp: 0 })
        .where(eq(usageCountersSchema.organizationId, orgId));
    }
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: previousPlan === plan ? 'plan.renewed' : 'plan.upgraded',
    entityType: 'subscription',
    entityId: orgId,
    before: { plan: previousPlan },
    after: { plan },
  });

  revalidatePath('/dashboard/plans');

  return currentPlan();
}

// Cancellation is modeled as a downgrade to the default (free) plan so the
// invariant "one active subscription per org" stays intact. Counters are reset
// to default-tier limits, mirroring upgradePlan().
export async function cancelSubscription(): Promise<PlanSnapshot> {
  const { userId, orgId } = await requireAdminOrg();

  const defaultSlug = await getDefaultPlanSlug();
  const previousPlan = await getActivePlan(orgId);
  if (previousPlan === defaultSlug) {
    return currentPlan();
  }

  const monthlyLimit = await poolLimitForPlan(defaultSlug);

  // Atomic downgrade to the default plan — same reasoning as upgradePlan: the
  // deactivate + activate + counter reset must not be interruptible.
  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionsSchema)
      .set({ active: false })
      .where(
        and(
          eq(subscriptionsSchema.organizationId, orgId),
          eq(subscriptionsSchema.active, true),
        ),
      );

    await tx.insert(subscriptionsSchema).values({
      organizationId: orgId,
      plan: defaultSlug,
      active: true,
    });

    await tx
      .update(usageCountersSchema)
      .set({ used: 0, monthlyLimit, toppedUp: 0 })
      .where(eq(usageCountersSchema.organizationId, orgId));
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'subscription.canceled',
    entityType: 'subscription',
    entityId: orgId,
    before: { plan: previousPlan },
    after: { plan: defaultSlug },
  });

  revalidatePath('/dashboard/plans');

  return currentPlan();
}

// Starts a Wompi Web Checkout for an AI-credit top-up package. Records a
// `pending` top_ups row up front (so the reference exists before the tenant
// ever reaches Wompi) and grants NOTHING here — credits are only granted once
// Wompi confirms the payment (see confirmTopUpPayment / applyApprovedTopUp,
// driven by the webhook + an authoritative query fallback).
export async function createTopUpCheckout(
  packageId: string,
): Promise<{ url: string }> {
  const { userId, orgId } = await requireAdminOrg();

  const pkg = findPackage(packageId);
  if (!pkg) {
    throw new Error(`Unknown top-up package: ${packageId}`);
  }

  if (!Env.WOMPI_INTEGRITY_SECRET || !Env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY) {
    throw new Error('Payments are not configured');
  }

  const reference = `topup-${randomUUID()}`;
  const amountInCents = Math.round(pkg.amountCop * 100);

  await db.insert(topUpsSchema).values({
    organizationId: orgId,
    amountCop: pkg.amountCop.toFixed(2),
    requestsAdded: pkg.requests,
    reference,
    status: 'pending',
  });

  const signature = integritySignature({
    reference,
    amountInCents,
    currency: 'COP',
    integritySecret: Env.WOMPI_INTEGRITY_SECRET,
  });

  const redirectUrl = Env.NEXT_PUBLIC_APP_URL
    ? `${Env.NEXT_PUBLIC_APP_URL}/dashboard/plans?topup=${reference}`
    : undefined;

  const url = buildCheckoutUrl({
    publicKey: Env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY,
    currency: 'COP',
    amountInCents,
    reference,
    signature,
    redirectUrl,
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'topup.checkout_created',
    entityType: 'top_up',
    entityId: reference,
    after: {
      packageId,
      amountCop: pkg.amountCop,
      requests: pkg.requests,
    },
  });

  return { url };
}

// The atomic claim-and-increment core of the APPROVED path. Extracted so it
// can be exercised directly against PGlite (see topup-confirm.test.ts) without
// needing the plan catalog / Clerk auth that confirmTopUpPayment depends on.
//
// The WHERE status='pending' guard on the UPDATE is the idempotency gate: two
// callers racing for the same reference (webhook retry, or the webhook racing
// the authoritative-query fallback) can only ever produce ONE increment — the
// first to claim the row wins, the second finds zero rows and no-ops.
//
// Callers MUST ensure a usage_counters row already exists for organizationId
// — confirmTopUpPayment does so via ensureCountersForPlan before calling this.
export async function applyApprovedTopUp(
  reference: string,
  wompiTransactionId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(topUpsSchema)
      .set({ status: 'approved', wompiTransactionId })
      .where(
        and(
          eq(topUpsSchema.reference, reference),
          eq(topUpsSchema.status, 'pending'),
        ),
      )
      .returning({
        orgId: topUpsSchema.organizationId,
        requests: topUpsSchema.requestsAdded,
      });

    if (claimed.length === 0) {
      return;
    }

    const row = claimed[0]!;
    await tx
      .update(usageCountersSchema)
      .set({ toppedUp: sql`${usageCountersSchema.toppedUp} + ${row.requests}` })
      .where(eq(usageCountersSchema.organizationId, row.orgId));
  });
}

// Applies the outcome Wompi reported for a top-up's checkout `reference` —
// called from the webhook (src/app/api/webhooks/wompi/route.ts) after
// checksum verification and a best-effort authoritative status query.
// Unknown references and already-processed (non-pending) references are
// silently ignored: the former can be a checksum-valid event for someone
// else's reference (impossible in practice, but harmless), the latter is the
// expected shape of a Wompi retry.
export async function confirmTopUpPayment(
  reference: string,
  wompiStatus: string,
  wompiTransactionId: string | null,
): Promise<void> {
  if (wompiStatus.toUpperCase() !== 'APPROVED') {
    await db
      .update(topUpsSchema)
      .set({ status: wompiStatus.toLowerCase(), wompiTransactionId })
      .where(
        and(
          eq(topUpsSchema.reference, reference),
          eq(topUpsSchema.status, 'pending'),
        ),
      );
    return;
  }

  const [pending] = await db
    .select({
      organizationId: topUpsSchema.organizationId,
      status: topUpsSchema.status,
    })
    .from(topUpsSchema)
    .where(eq(topUpsSchema.reference, reference))
    .limit(1);

  if (!pending || pending.status !== 'pending') {
    return;
  }

  await ensureCountersForPlan(
    pending.organizationId,
    await getActivePlan(pending.organizationId),
  );

  await applyApprovedTopUp(reference, wompiTransactionId);
}

async function getActivePlan(orgId: string): Promise<PlanName> {
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
  return active ? active.plan : getDefaultPlanSlug();
}

export type ConsumeResult
  = | { success: true; remaining: number }
    | { success: false; remaining: 0 };

// Atomically decrements the shared pool. The WHERE clause
// `used < monthly_limit + topped_up` is the race guard — Postgres serializes
// the UPDATE on the row, so concurrent callers either succeed (and we get a
// row back) or fail (no rows updated). Every AI/e-invoicing action draws 1
// credit from this same org-wide pool.
export async function consumeCredit(): Promise<ConsumeResult> {
  const { orgId } = await requireOrg();
  return consumeCreditForOrg(orgId);
}

// Same as consumeCredit but for an explicit org — usable from background hooks
// (e.g. auto e-invoicing after a sale) that run without a Clerk session.
export async function consumeCreditForOrg(
  orgId: string,
): Promise<ConsumeResult> {
  await ensureCountersForPlan(orgId, await getActivePlan(orgId));

  const updated = await db
    .update(usageCountersSchema)
    .set({ used: sql`${usageCountersSchema.used} + 1` })
    .where(
      and(
        eq(usageCountersSchema.organizationId, orgId),
        sql`${usageCountersSchema.used} < ${usageCountersSchema.monthlyLimit} + ${usageCountersSchema.toppedUp}`,
      ),
    )
    .returning({
      used: usageCountersSchema.used,
      monthlyLimit: usageCountersSchema.monthlyLimit,
      toppedUp: usageCountersSchema.toppedUp,
    });

  if (updated.length === 0) {
    return { success: false, remaining: 0 };
  }

  const row = updated[0]!;
  const remaining = Math.max(0, row.monthlyLimit + row.toppedUp - row.used);
  return { success: true, remaining };
}
