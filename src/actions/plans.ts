'use server';

import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  subscriptionsSchema,
  topUpsSchema,
  usageCountersSchema,
} from '@/models/Schema';

export type PlanName = 'free' | 'pro' | 'business';
export type AgentKind = 'sales_manager' | 'customer_service';

// Not exported: a "use server" module may only export async functions.
// These are internal constants used by the actions below.
const PLAN_LIMITS: Record<PlanName, Record<AgentKind, number>> = {
  free: { sales_manager: 0, customer_service: 0 },
  pro: { sales_manager: 500, customer_service: 0 },
  business: { sales_manager: 500, customer_service: 1000 },
};

const AGENT_KINDS: AgentKind[] = ['sales_manager', 'customer_service'];

export type CurrentPlan = {
  plan: PlanName;
  active: boolean;
  periodStart: string | null;
  periodEnd: string | null;
};

export type CounterRow = {
  agentKind: AgentKind;
  used: number;
  monthlyLimit: number;
  toppedUp: number;
  remaining: number;
  resetAt: string | null;
};

export type PlanSnapshot = {
  subscription: CurrentPlan;
  counters: CounterRow[];
};

function isPlan(value: string): value is PlanName {
  return value === 'free' || value === 'pro' || value === 'business';
}

function isAgentKind(value: string): value is AgentKind {
  return value === 'sales_manager' || value === 'customer_service';
}

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
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage the plan');
  }
  return { userId, orgId };
}

async function ensureCountersForPlan(orgId: string, plan: PlanName) {
  const limits = PLAN_LIMITS[plan];
  for (const kind of AGENT_KINDS) {
    await db
      .insert(usageCountersSchema)
      .values({
        organizationId: orgId,
        agentKind: kind,
        used: 0,
        monthlyLimit: limits[kind],
        toppedUp: 0,
      })
      .onConflictDoNothing({
        target: [
          usageCountersSchema.organizationId,
          usageCountersSchema.agentKind,
        ],
      });
  }
}

async function readCounters(orgId: string): Promise<CounterRow[]> {
  const rows = await db
    .select()
    .from(usageCountersSchema)
    .where(eq(usageCountersSchema.organizationId, orgId));

  const byKind = new Map(rows.map(r => [r.agentKind, r] as const));
  return AGENT_KINDS.map((kind) => {
    const r = byKind.get(kind);
    const used = r?.used ?? 0;
    const monthlyLimit = r?.monthlyLimit ?? 0;
    const toppedUp = r?.toppedUp ?? 0;
    return {
      agentKind: kind,
      used,
      monthlyLimit,
      toppedUp,
      remaining: Math.max(0, monthlyLimit + toppedUp - used),
      resetAt: r?.resetAt ? r.resetAt.toISOString() : null,
    };
  });
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

  const plan: PlanName
    = active && isPlan(active.plan) ? active.plan : 'free';

  await ensureCountersForPlan(orgId, plan);

  const counters = await readCounters(orgId);

  return {
    subscription: {
      plan,
      active: active ? active.active : true,
      periodStart: active?.periodStart
        ? active.periodStart.toISOString()
        : null,
      periodEnd: active?.periodEnd ? active.periodEnd.toISOString() : null,
    },
    counters,
  };
}

export async function upgradePlan(plan: PlanName): Promise<PlanSnapshot> {
  if (!isPlan(plan)) {
    throw new Error(`Unknown plan: ${String(plan)}`);
  }
  const { userId, orgId } = await requireAdminOrg();

  const previousPlan = await getActivePlan(orgId);

  await db
    .update(subscriptionsSchema)
    .set({ active: false })
    .where(
      and(
        eq(subscriptionsSchema.organizationId, orgId),
        eq(subscriptionsSchema.active, true),
      ),
    );

  await db.insert(subscriptionsSchema).values({
    organizationId: orgId,
    plan,
    active: true,
  });

  const limits = PLAN_LIMITS[plan];
  for (const kind of AGENT_KINDS) {
    const inserted = await db
      .insert(usageCountersSchema)
      .values({
        organizationId: orgId,
        agentKind: kind,
        used: 0,
        monthlyLimit: limits[kind],
        toppedUp: 0,
      })
      .onConflictDoNothing({
        target: [
          usageCountersSchema.organizationId,
          usageCountersSchema.agentKind,
        ],
      })
      .returning({ id: usageCountersSchema.id });

    if (inserted.length === 0) {
      await db
        .update(usageCountersSchema)
        .set({ used: 0, monthlyLimit: limits[kind], toppedUp: 0 })
        .where(
          and(
            eq(usageCountersSchema.organizationId, orgId),
            eq(usageCountersSchema.agentKind, kind),
          ),
        );
    }
  }

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

// Cancellation is modeled as a downgrade to the free plan so the invariant
// "one active subscription per org" stays intact. Counters are reset to
// free-tier limits, mirroring upgradePlan().
export async function cancelSubscription(): Promise<PlanSnapshot> {
  const { userId, orgId } = await requireAdminOrg();

  const previousPlan = await getActivePlan(orgId);
  if (previousPlan === 'free') {
    return currentPlan();
  }

  await db
    .update(subscriptionsSchema)
    .set({ active: false })
    .where(
      and(
        eq(subscriptionsSchema.organizationId, orgId),
        eq(subscriptionsSchema.active, true),
      ),
    );

  await db.insert(subscriptionsSchema).values({
    organizationId: orgId,
    plan: 'free',
    active: true,
  });

  const limits = PLAN_LIMITS.free;
  for (const kind of AGENT_KINDS) {
    await db
      .update(usageCountersSchema)
      .set({ used: 0, monthlyLimit: limits[kind], toppedUp: 0 })
      .where(
        and(
          eq(usageCountersSchema.organizationId, orgId),
          eq(usageCountersSchema.agentKind, kind),
        ),
      );
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'subscription.canceled',
    entityType: 'subscription',
    entityId: orgId,
    before: { plan: previousPlan },
    after: { plan: 'free' },
  });

  revalidatePath('/dashboard/plans');

  return currentPlan();
}

export async function topUp(
  agentKind: AgentKind,
  requests: number,
  amountCop: number,
): Promise<PlanSnapshot> {
  if (!isAgentKind(agentKind)) {
    throw new Error(`Unknown agent kind: ${String(agentKind)}`);
  }
  if (!Number.isInteger(requests) || requests <= 0) {
    throw new Error('requests must be a positive integer');
  }
  if (!Number.isFinite(amountCop) || amountCop < 0) {
    throw new Error('amountCop must be a non-negative number');
  }

  const { orgId } = await requireAdminOrg();

  await ensureCountersForPlan(orgId, await getActivePlan(orgId));

  await db.insert(topUpsSchema).values({
    organizationId: orgId,
    agentKind,
    amountCop: amountCop.toFixed(2),
    requestsAdded: requests,
  });

  await db
    .update(usageCountersSchema)
    .set({ toppedUp: sql`${usageCountersSchema.toppedUp} + ${requests}` })
    .where(
      and(
        eq(usageCountersSchema.organizationId, orgId),
        eq(usageCountersSchema.agentKind, agentKind),
      ),
    );

  revalidatePath('/dashboard/plans');

  return currentPlan();
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
  return active && isPlan(active.plan) ? active.plan : 'free';
}

export type ConsumeResult
  = | { success: true; remaining: number }
    | { success: false; remaining: 0 };

// Atomically decrements quota. The WHERE clause `used < monthly_limit + topped_up`
// is the race guard — Postgres serializes the UPDATE on the row, so concurrent
// callers either succeed (and we get a row back) or fail (no rows updated).
export async function consumeCredit(
  agentKind: AgentKind,
): Promise<ConsumeResult> {
  if (!isAgentKind(agentKind)) {
    throw new Error(`Unknown agent kind: ${String(agentKind)}`);
  }
  const { orgId } = await requireOrg();

  await ensureCountersForPlan(orgId, await getActivePlan(orgId));

  const updated = await db
    .update(usageCountersSchema)
    .set({ used: sql`${usageCountersSchema.used} + 1` })
    .where(
      and(
        eq(usageCountersSchema.organizationId, orgId),
        eq(usageCountersSchema.agentKind, agentKind),
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
