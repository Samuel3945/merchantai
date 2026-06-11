'use server';

import type { ActionResult } from '@/libs/action-result';
import { and, asc, eq, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { requirePlatformOperator } from '@/libs/platform/operator';
import { planEntitlementsSchema, plansSchema } from '@/models/Schema';

/**
 * Operator-only CRUD for the plan catalog (the Pricing Studio behind
 * /platform/plans). Every action re-checks the platform operator gate and
 * writes an audit trail under organizationId 'platform'.
 *
 * Plans are never hard-deleted: subscriptions reference them by slug, so
 * retiring a plan means archiving it (existing orgs keep their limits, new
 * upgrades can't pick it). Slugs are immutable after creation for the same
 * reason.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ENTITLEMENT_KEY_RE = /^[a-z][a-z0-9_]*$/;

const PLATFORM_ORG = 'platform';

export type PlanEntitlementRow = {
  key: string;
  value: number;
};

export type PlatformPlan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthlyCop: number;
  priceAnnualCop: number | null;
  featureBullets: string[];
  isPublic: boolean;
  isDefault: boolean;
  isArchived: boolean;
  sortOrder: number;
  entitlements: PlanEntitlementRow[];
};

export type PlanFields = {
  name: string;
  description: string;
  priceMonthlyCop: number;
  priceAnnualCop: number | null;
  featureBullets: string[];
  isPublic: boolean;
  sortOrder: number;
};

function cleanBullets(bullets: string[]): string[] {
  return bullets.map(b => b.trim()).filter(Boolean);
}

function validateFields(fields: PlanFields): string | null {
  if (!fields.name.trim()) {
    return 'El nombre del plan es obligatorio';
  }
  if (
    !Number.isFinite(fields.priceMonthlyCop)
    || fields.priceMonthlyCop < 0
  ) {
    return 'El precio mensual debe ser un número mayor o igual a 0';
  }
  if (
    fields.priceAnnualCop !== null
    && (!Number.isFinite(fields.priceAnnualCop) || fields.priceAnnualCop < 0)
  ) {
    return 'El precio anual debe ser un número mayor o igual a 0';
  }
  if (!Number.isInteger(fields.sortOrder)) {
    return 'El orden debe ser un número entero';
  }
  return null;
}

function revalidatePlanSurfaces(): void {
  revalidatePath('/platform/plans');
  revalidatePath('/dashboard/plans');
}

export async function listPlatformPlans(): Promise<PlatformPlan[]> {
  await requirePlatformOperator();

  const [plans, entitlements] = await Promise.all([
    db
      .select()
      .from(plansSchema)
      .orderBy(asc(plansSchema.sortOrder), asc(plansSchema.createdAt)),
    db
      .select({
        planId: planEntitlementsSchema.planId,
        key: planEntitlementsSchema.key,
        value: planEntitlementsSchema.value,
      })
      .from(planEntitlementsSchema)
      .orderBy(asc(planEntitlementsSchema.key)),
  ]);

  const byPlan = new Map<string, PlanEntitlementRow[]>();
  for (const row of entitlements) {
    const list = byPlan.get(row.planId) ?? [];
    list.push({ key: row.key, value: row.value });
    byPlan.set(row.planId, list);
  }

  return plans.map(p => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    priceMonthlyCop: Number(p.priceMonthlyCop),
    priceAnnualCop: p.priceAnnualCop === null ? null : Number(p.priceAnnualCop),
    featureBullets: p.featureBullets,
    isPublic: p.isPublic,
    isDefault: p.isDefault,
    isArchived: p.isArchived,
    sortOrder: p.sortOrder,
    entitlements: byPlan.get(p.id) ?? [],
  }));
}

export async function createPlan(
  input: PlanFields & { slug: string },
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error:
        'El identificador solo permite minúsculas, números, guion y guion bajo',
    };
  }
  const fieldError = validateFields(input);
  if (fieldError) {
    return { ok: false, error: fieldError };
  }

  const [existing] = await db
    .select({ id: plansSchema.id })
    .from(plansSchema)
    .where(eq(plansSchema.slug, slug))
    .limit(1);
  if (existing) {
    return { ok: false, error: `Ya existe un plan con identificador "${slug}"` };
  }

  const [created] = await db
    .insert(plansSchema)
    .values({
      slug,
      name: input.name.trim(),
      description: input.description.trim() || null,
      priceMonthlyCop: input.priceMonthlyCop.toFixed(2),
      priceAnnualCop:
        input.priceAnnualCop === null ? null : input.priceAnnualCop.toFixed(2),
      featureBullets: cleanBullets(input.featureBullets),
      isPublic: input.isPublic,
      sortOrder: input.sortOrder,
    })
    .returning({ id: plansSchema.id });

  if (!created) {
    return { ok: false, error: 'No se pudo crear el plan' };
  }

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.plan.created',
    entityType: 'plan',
    entityId: created.id,
    after: { slug, name: input.name, priceMonthlyCop: input.priceMonthlyCop },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: created };
}

export async function updatePlan(
  id: string,
  fields: PlanFields,
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const fieldError = validateFields(fields);
  if (fieldError) {
    return { ok: false, error: fieldError };
  }

  const [before] = await db
    .select()
    .from(plansSchema)
    .where(eq(plansSchema.id, id))
    .limit(1);
  if (!before) {
    return { ok: false, error: 'Plan no encontrado' };
  }

  await db
    .update(plansSchema)
    .set({
      name: fields.name.trim(),
      description: fields.description.trim() || null,
      priceMonthlyCop: fields.priceMonthlyCop.toFixed(2),
      priceAnnualCop:
        fields.priceAnnualCop === null ? null : fields.priceAnnualCop.toFixed(2),
      featureBullets: cleanBullets(fields.featureBullets),
      isPublic: fields.isPublic,
      sortOrder: fields.sortOrder,
    })
    .where(eq(plansSchema.id, id));

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.plan.updated',
    entityType: 'plan',
    entityId: id,
    before: {
      name: before.name,
      priceMonthlyCop: Number(before.priceMonthlyCop),
      isPublic: before.isPublic,
    },
    after: {
      name: fields.name,
      priceMonthlyCop: fields.priceMonthlyCop,
      isPublic: fields.isPublic,
    },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: { id } };
}

export async function setPlanArchived(
  id: string,
  archived: boolean,
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const [plan] = await db
    .select({ isDefault: plansSchema.isDefault, slug: plansSchema.slug })
    .from(plansSchema)
    .where(eq(plansSchema.id, id))
    .limit(1);
  if (!plan) {
    return { ok: false, error: 'Plan no encontrado' };
  }
  if (archived && plan.isDefault) {
    return {
      ok: false,
      error: 'No se puede archivar el plan predeterminado',
    };
  }

  await db
    .update(plansSchema)
    .set({ isArchived: archived })
    .where(eq(plansSchema.id, id));

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: archived ? 'platform.plan.archived' : 'platform.plan.restored',
    entityType: 'plan',
    entityId: id,
    after: { slug: plan.slug, archived },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: { id } };
}

export async function setDefaultPlan(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const operator = await requirePlatformOperator();

  const [plan] = await db
    .select({ isArchived: plansSchema.isArchived, slug: plansSchema.slug })
    .from(plansSchema)
    .where(eq(plansSchema.id, id))
    .limit(1);
  if (!plan) {
    return { ok: false, error: 'Plan no encontrado' };
  }
  if (plan.isArchived) {
    return {
      ok: false,
      error: 'Un plan archivado no puede ser el predeterminado',
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(plansSchema)
      .set({ isDefault: false })
      .where(ne(plansSchema.id, id));
    await tx
      .update(plansSchema)
      .set({ isDefault: true })
      .where(eq(plansSchema.id, id));
  });

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.plan.default_changed',
    entityType: 'plan',
    entityId: id,
    after: { slug: plan.slug },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: { id } };
}

export async function setPlanEntitlement(
  planId: string,
  key: string,
  value: number,
): Promise<ActionResult<{ key: string; value: number }>> {
  const operator = await requirePlatformOperator();

  const cleanKey = key.trim().toLowerCase();
  if (!ENTITLEMENT_KEY_RE.test(cleanKey)) {
    return {
      ok: false,
      error:
        'La clave solo permite minúsculas, números y guion bajo (ej. max_cashiers)',
    };
  }
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, error: 'El valor debe ser un entero mayor o igual a 0' };
  }

  const [plan] = await db
    .select({ slug: plansSchema.slug })
    .from(plansSchema)
    .where(eq(plansSchema.id, planId))
    .limit(1);
  if (!plan) {
    return { ok: false, error: 'Plan no encontrado' };
  }

  await db
    .insert(planEntitlementsSchema)
    .values({ planId, key: cleanKey, value })
    .onConflictDoUpdate({
      target: [planEntitlementsSchema.planId, planEntitlementsSchema.key],
      set: { value },
    });

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.plan.entitlement_set',
    entityType: 'plan',
    entityId: planId,
    after: { plan: plan.slug, key: cleanKey, value },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: { key: cleanKey, value } };
}

export async function removePlanEntitlement(
  planId: string,
  key: string,
): Promise<ActionResult<{ key: string }>> {
  const operator = await requirePlatformOperator();

  await db
    .delete(planEntitlementsSchema)
    .where(
      and(
        eq(planEntitlementsSchema.planId, planId),
        eq(planEntitlementsSchema.key, key),
      ),
    );

  await logAction({
    organizationId: PLATFORM_ORG,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.plan.entitlement_removed',
    entityType: 'plan',
    entityId: planId,
    after: { key },
  });

  revalidatePlanSurfaces();
  return { ok: true, data: { key } };
}
