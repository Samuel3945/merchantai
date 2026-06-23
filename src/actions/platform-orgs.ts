'use server';

import type { ActionResult } from '@/libs/action-result';
import { clerkClient } from '@clerk/nextjs/server';
import { and, asc, count, desc, eq, gte, max, sql, sum } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { getPlanEntitlementsBySlug, limitOf } from '@/libs/entitlements';
import {
  ONBOARDING_FORCED_KEY,
  PLATFORM_GLOBAL_ORG_ID,
} from '@/libs/platform/global-settings';
import { requirePlatformOperator } from '@/libs/platform/operator';
import {
  appSettingsSchema,
  auditLogsSchema,
  businessProfileSchema,
  planAddonsSchema,
  plansSchema,
  platformOrgMetadataSchema,
  posUsersSchema,
  salesSchema,
  subscriptionsSchema,
  topUpsSchema,
  usageCountersSchema,
} from '@/models/Schema';

/**
 * Operator-only directory and control plane over every business. Read side
 * merges Clerk organizations (identity: name, owner) with cross-tenant DB
 * aggregates; write side is the operator's "one click" levers: assign plan,
 * grant add-ons/credits, override per-org settings, curate metadata.
 *
 * Every action re-checks the operator gate and audits under the TARGET org so
 * the trail shows up in that business's history.
 */

const ORG_STATUSES = ['none', 'trial', 'vip', 'at_risk', 'churned'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

const AGENT_KINDS = ['sales_manager', 'customer_service'] as const;
export type PlatformAgentKind = (typeof AGENT_KINDS)[number];

export type PlatformOrgRow = {
  organizationId: string;
  name: string;
  createdAt: string | null;
  membersCount: number | null;
  planSlug: string;
  planName: string;
  status: OrgStatus;
  tags: string[];
  groupName: string | null;
  sales30d: number;
  revenue30d: number;
  lastSaleAt: string | null;
  activeCashiers: number;
};

export type OrgBusinessProfile = {
  productCount: number;
  activeProductCount: number;
  perishableCount: number;
  wholesaleCount: number;
  distinctCategories: number;
  totalStockUnits: number;
  salesCount30d: number;
  distinctProductsSold30d: number;
  topCategories: { name: string; usageCount: number }[];
  inferredBusinessType: string | null;
  computedAt: string;
};

export type OrgActivityEntry = {
  id: string;
  action: string;
  actorType: string;
  entityType: string;
  createdAt: string;
};

export type PlatformOrgDetail = PlatformOrgRow & {
  notes: string | null;
  knownIssues: string | null;
  addons: { id: string; addon: string; qty: number; active: boolean }[];
  counters: {
    agentKind: string;
    used: number;
    monthlyLimit: number;
    toppedUp: number;
  }[];
  settings: { key: string; value: string }[];
  profile: OrgBusinessProfile | null;
  recentActivity: OrgActivityEntry[];
};

function toIso(date: Date | string | null | undefined): string | null {
  if (!date) {
    return null;
  }
  return typeof date === 'string' ? date : date.toISOString();
}

async function fetchClerkOrgs(): Promise<
  Map<string, { name: string; createdAt: string | null; membersCount: number | null }>
> {
  const map = new Map<
    string,
    { name: string; createdAt: string | null; membersCount: number | null }
  >();
  try {
    const client = await clerkClient();
    let offset = 0;
    const limit = 100;
    // Paginate defensively; the platform is small today but won't stay small.
    for (let page = 0; page < 50; page++) {
      const res = await client.organizations.getOrganizationList({
        limit,
        offset,
        includeMembersCount: true,
      });
      for (const org of res.data) {
        map.set(org.id, {
          name: org.name,
          createdAt: org.createdAt ? new Date(org.createdAt).toISOString() : null,
          membersCount: org.membersCount ?? null,
        });
      }
      offset += limit;
      if (res.data.length < limit) {
        break;
      }
    }
  } catch {
    // Clerk being unreachable must not blank the directory: DB aggregates
    // still render with the org id as the display name.
  }
  return map;
}

export async function listPlatformOrgs(): Promise<PlatformOrgRow[]> {
  await requirePlatformOperator();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [clerkOrgs, subs, salesAgg, cashiers, metadata, planRows]
    = await Promise.all([
      fetchClerkOrgs(),
      db
        .select({
          organizationId: subscriptionsSchema.organizationId,
          plan: subscriptionsSchema.plan,
        })
        .from(subscriptionsSchema)
        .where(eq(subscriptionsSchema.active, true)),
      db
        .select({
          organizationId: salesSchema.organizationId,
          sales30d: count(),
          revenue30d: sum(salesSchema.total),
          lastSaleAt: max(salesSchema.createdAt),
        })
        .from(salesSchema)
        .where(
          and(
            eq(salesSchema.status, 'completed'),
            gte(salesSchema.createdAt, thirtyDaysAgo),
          ),
        )
        .groupBy(salesSchema.organizationId),
      db
        .select({
          organizationId: posUsersSchema.organizationId,
          activeCashiers: count(),
        })
        .from(posUsersSchema)
        .where(eq(posUsersSchema.active, true))
        .groupBy(posUsersSchema.organizationId),
      db.select().from(platformOrgMetadataSchema),
      db
        .select({ slug: plansSchema.slug, name: plansSchema.name })
        .from(plansSchema),
    ]);

  const planNames = new Map(planRows.map(p => [p.slug, p.name]));
  const subByOrg = new Map(subs.map(s => [s.organizationId, s.plan]));
  const salesByOrg = new Map(salesAgg.map(s => [s.organizationId, s]));
  const cashiersByOrg = new Map(
    cashiers.map(c => [c.organizationId, c.activeCashiers]),
  );
  const metaByOrg = new Map(metadata.map(m => [m.organizationId, m]));

  // Universe of org ids = Clerk orgs ∪ orgs seen in the DB.
  const orgIds = new Set<string>([
    ...clerkOrgs.keys(),
    ...subByOrg.keys(),
    ...salesByOrg.keys(),
    ...cashiersByOrg.keys(),
    ...metaByOrg.keys(),
  ]);

  const rows: PlatformOrgRow[] = [];
  for (const orgId of orgIds) {
    const clerk = clerkOrgs.get(orgId);
    const meta = metaByOrg.get(orgId);
    const salesRow = salesByOrg.get(orgId);
    const planSlug = subByOrg.get(orgId) ?? 'free';
    rows.push({
      organizationId: orgId,
      name: clerk?.name ?? orgId,
      createdAt: clerk?.createdAt ?? null,
      membersCount: clerk?.membersCount ?? null,
      planSlug,
      planName: planNames.get(planSlug) ?? planSlug,
      status: (meta?.status as OrgStatus | undefined) ?? 'none',
      tags: meta?.tags ?? [],
      groupName: meta?.groupName ?? null,
      sales30d: Number(salesRow?.sales30d ?? 0),
      revenue30d: Number(salesRow?.revenue30d ?? 0),
      lastSaleAt: toIso(salesRow?.lastSaleAt ?? null),
      activeCashiers: Number(cashiersByOrg.get(orgId) ?? 0),
    });
  }

  rows.sort((a, b) => b.revenue30d - a.revenue30d || a.name.localeCompare(b.name));
  return rows;
}

export async function getPlatformOrgDetail(
  orgId: string,
): Promise<PlatformOrgDetail | null> {
  await requirePlatformOperator();

  const all = await listPlatformOrgs();
  const base = all.find(r => r.organizationId === orgId);
  if (!base) {
    return null;
  }

  const [meta, addons, counters, settings, profileRows, activity]
    = await Promise.all([
      db
        .select()
        .from(platformOrgMetadataSchema)
        .where(eq(platformOrgMetadataSchema.organizationId, orgId))
        .limit(1),
      db
        .select({
          id: planAddonsSchema.id,
          addon: planAddonsSchema.addon,
          qty: planAddonsSchema.qty,
          active: planAddonsSchema.active,
        })
        .from(planAddonsSchema)
        .where(eq(planAddonsSchema.organizationId, orgId))
        .orderBy(desc(planAddonsSchema.createdAt)),
      db
        .select({
          agentKind: usageCountersSchema.agentKind,
          used: usageCountersSchema.used,
          monthlyLimit: usageCountersSchema.monthlyLimit,
          toppedUp: usageCountersSchema.toppedUp,
        })
        .from(usageCountersSchema)
        .where(eq(usageCountersSchema.organizationId, orgId)),
      db
        .select({ key: appSettingsSchema.key, value: appSettingsSchema.value })
        .from(appSettingsSchema)
        .where(eq(appSettingsSchema.organizationId, orgId))
        .orderBy(asc(appSettingsSchema.key)),
      db
        .select()
        .from(businessProfileSchema)
        .where(eq(businessProfileSchema.organizationId, orgId))
        .limit(1),
      db
        .select({
          id: auditLogsSchema.id,
          action: auditLogsSchema.action,
          actorType: auditLogsSchema.actorType,
          entityType: auditLogsSchema.entityType,
          createdAt: auditLogsSchema.createdAt,
        })
        .from(auditLogsSchema)
        .where(eq(auditLogsSchema.organizationId, orgId))
        .orderBy(desc(auditLogsSchema.createdAt))
        .limit(15),
    ]);

  const profileRow = profileRows[0];

  return {
    ...base,
    notes: meta[0]?.notes ?? null,
    knownIssues: meta[0]?.knownIssues ?? null,
    addons,
    counters,
    settings,
    profile: profileRow
      ? {
          productCount: profileRow.productCount,
          activeProductCount: profileRow.activeProductCount,
          perishableCount: profileRow.perishableCount,
          wholesaleCount: profileRow.wholesaleCount,
          distinctCategories: profileRow.distinctCategories,
          totalStockUnits: profileRow.totalStockUnits,
          salesCount30d: profileRow.salesCount30d,
          distinctProductsSold30d: profileRow.distinctProductsSold30d,
          topCategories: profileRow.topCategories,
          inferredBusinessType: profileRow.inferredBusinessType,
          computedAt: profileRow.computedAt.toISOString(),
        }
      : null,
    recentActivity: activity.map(a => ({
      id: a.id,
      action: a.action,
      actorType: a.actorType,
      entityType: a.entityType,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export type OrgMetadataInput = {
  status: OrgStatus;
  tags: string[];
  groupName: string;
  notes: string;
  knownIssues: string;
};

export async function saveOrgMetadata(
  orgId: string,
  input: OrgMetadataInput,
): Promise<ActionResult<{ organizationId: string }>> {
  const operator = await requirePlatformOperator();

  if (!ORG_STATUSES.includes(input.status)) {
    return { ok: false, error: 'Estado inválido' };
  }

  const values = {
    status: input.status,
    tags: input.tags.map(t => t.trim()).filter(Boolean),
    groupName: input.groupName.trim() || null,
    notes: input.notes.trim() || null,
    knownIssues: input.knownIssues.trim() || null,
  };

  await db
    .insert(platformOrgMetadataSchema)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({
      target: [platformOrgMetadataSchema.organizationId],
      set: values,
    });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.metadata_saved',
    entityType: 'platform_org_metadata',
    entityId: orgId,
    after: { status: values.status, tags: values.tags },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { organizationId: orgId } };
}

// Operator-side plan assignment. Unlike the tenant's upgradePlan(), hidden
// (non-public) plans ARE assignable — that's the whole point of custom deals —
// but archived plans are not.
export async function assignPlanToOrg(
  orgId: string,
  planSlug: string,
): Promise<ActionResult<{ plan: string }>> {
  const operator = await requirePlatformOperator();

  const [plan] = await db
    .select({ slug: plansSchema.slug, isArchived: plansSchema.isArchived })
    .from(plansSchema)
    .where(eq(plansSchema.slug, planSlug))
    .limit(1);
  if (!plan) {
    return { ok: false, error: `No existe el plan "${planSlug}"` };
  }
  if (plan.isArchived) {
    return { ok: false, error: 'No se puede asignar un plan archivado' };
  }

  const [previous] = await db
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
      plan: planSlug,
      active: true,
    });
  });

  // Mirror upgradePlan(): counters reset to the new plan's AI limits.
  const entitlements = await getPlanEntitlementsBySlug(planSlug);
  for (const kind of AGENT_KINDS) {
    const monthlyLimit = entitlements
      ? limitOf(entitlements, `ai_credits_${kind}`)
      : 0;
    await db
      .insert(usageCountersSchema)
      .values({
        organizationId: orgId,
        agentKind: kind,
        used: 0,
        monthlyLimit,
        toppedUp: 0,
      })
      .onConflictDoUpdate({
        target: [
          usageCountersSchema.organizationId,
          usageCountersSchema.agentKind,
        ],
        set: { used: 0, monthlyLimit, toppedUp: 0 },
      });
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.plan_assigned',
    entityType: 'subscription',
    entityId: orgId,
    before: { plan: previous?.plan ?? null },
    after: { plan: planSlug },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { plan: planSlug } };
}

export async function grantAddon(
  orgId: string,
  addon: string,
  qty: number,
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const cleanAddon = addon.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(cleanAddon)) {
    return { ok: false, error: 'Identificador de add-on inválido' };
  }
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, error: 'La cantidad debe ser un entero ≥ 1' };
  }

  const [created] = await db
    .insert(planAddonsSchema)
    .values({ organizationId: orgId, addon: cleanAddon, qty, active: true })
    .returning({ id: planAddonsSchema.id });

  if (!created) {
    return { ok: false, error: 'No se pudo crear el add-on' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.addon_granted',
    entityType: 'plan_addon',
    entityId: created.id,
    after: { addon: cleanAddon, qty },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: created };
}

export async function setAddonActive(
  addonId: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const [updated] = await db
    .update(planAddonsSchema)
    .set({ active })
    .where(eq(planAddonsSchema.id, addonId))
    .returning({
      id: planAddonsSchema.id,
      organizationId: planAddonsSchema.organizationId,
      addon: planAddonsSchema.addon,
    });

  if (!updated) {
    return { ok: false, error: 'Add-on no encontrado' };
  }

  await logAction({
    organizationId: updated.organizationId,
    actor: { type: 'user', id: operator.userId },
    action: active ? 'platform.org.addon_enabled' : 'platform.org.addon_disabled',
    entityType: 'plan_addon',
    entityId: updated.id,
    after: { addon: updated.addon, active },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { id: updated.id } };
}

// Courtesy credits: recorded as a zero-amount top-up so the existing top-up
// history shows the grant, then applied to the live counter.
export async function grantCredits(
  orgId: string,
  agentKind: PlatformAgentKind,
  requests: number,
): Promise<ActionResult<{ requests: number }>> {
  const operator = await requirePlatformOperator();

  if (!AGENT_KINDS.includes(agentKind)) {
    return { ok: false, error: 'Agente desconocido' };
  }
  if (!Number.isInteger(requests) || requests < 1) {
    return { ok: false, error: 'Las consultas deben ser un entero ≥ 1' };
  }

  await db.insert(topUpsSchema).values({
    organizationId: orgId,
    agentKind,
    amountCop: '0.00',
    requestsAdded: requests,
  });

  await db
    .insert(usageCountersSchema)
    .values({
      organizationId: orgId,
      agentKind,
      used: 0,
      monthlyLimit: 0,
      toppedUp: requests,
    })
    .onConflictDoUpdate({
      target: [
        usageCountersSchema.organizationId,
        usageCountersSchema.agentKind,
      ],
      set: {
        toppedUp: sql`${usageCountersSchema.toppedUp} + ${requests}`,
      },
    });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.credits_granted',
    entityType: 'usage_counter',
    entityId: `${orgId}:${agentKind}`,
    after: { agentKind, requests },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { requests } };
}

export async function resetUsage(
  orgId: string,
  agentKind: PlatformAgentKind,
): Promise<ActionResult<{ agentKind: string }>> {
  const operator = await requirePlatformOperator();

  if (!AGENT_KINDS.includes(agentKind)) {
    return { ok: false, error: 'Agente desconocido' };
  }

  await db
    .update(usageCountersSchema)
    .set({ used: 0 })
    .where(
      and(
        eq(usageCountersSchema.organizationId, orgId),
        eq(usageCountersSchema.agentKind, agentKind),
      ),
    );

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.usage_reset',
    entityType: 'usage_counter',
    entityId: `${orgId}:${agentKind}`,
    after: { agentKind },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { agentKind } };
}

// Per-org feature override: writes the same app_settings the tenant features
// read (e.g. smartStockEnabled), so a single business can get a capability
// without changing its plan.
export async function setOrgSetting(
  orgId: string,
  key: string,
  value: string,
): Promise<ActionResult<{ key: string }>> {
  const operator = await requirePlatformOperator();

  const cleanKey = key.trim();
  if (!cleanKey) {
    return { ok: false, error: 'La clave es obligatoria' };
  }

  await db
    .insert(appSettingsSchema)
    .values({ organizationId: orgId, key: cleanKey, value })
    .onConflictDoUpdate({
      target: [appSettingsSchema.organizationId, appSettingsSchema.key],
      set: { value },
    });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.setting_set',
    entityType: 'app_setting',
    entityId: cleanKey,
    after: { key: cleanKey, value },
  });

  revalidatePath('/platform/businesses');
  return { ok: true, data: { key: cleanKey } };
}

// Platform-wide switch (not per-org): force every new owner through the
// onboarding wizard, or leave it OFF so the wizard is removed from the normal
// flow and only the operator can open it for testing. Persisted under the
// reserved global org id so no migration is needed. See libs/platform/global-settings.
export async function setOnboardingForced(
  enabled: boolean,
): Promise<ActionResult<{ enabled: boolean }>> {
  const operator = await requirePlatformOperator();

  const value = enabled ? 'true' : 'false';

  await db
    .insert(appSettingsSchema)
    .values({
      organizationId: PLATFORM_GLOBAL_ORG_ID,
      key: ONBOARDING_FORCED_KEY,
      value,
    })
    .onConflictDoUpdate({
      target: [appSettingsSchema.organizationId, appSettingsSchema.key],
      set: { value },
    });

  await logAction({
    organizationId: PLATFORM_GLOBAL_ORG_ID,
    actor: { type: 'user', id: operator.userId },
    action: enabled
      ? 'platform.onboarding_forced_enabled'
      : 'platform.onboarding_forced_disabled',
    entityType: 'app_setting',
    entityId: ONBOARDING_FORCED_KEY,
    after: { value },
  });

  revalidatePath('/platform');
  return { ok: true, data: { enabled } };
}
