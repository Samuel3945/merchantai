'use server';

import type { ActionResult } from '@/libs/action-result';
import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import {
  cleanActionPermissions,
  cleanEnabledModules,
} from '@/libs/permissions';
import { CASHIERS_LIMIT_REACHED } from '@/libs/plan-limits';
import {
  employeeInvitationsSchema,
  organizationPlansSchema,
  planAddonsSchema,
  posUsersSchema,
} from '@/models/Schema';

type PlanTier = 'free' | 'starter' | 'pro' | 'business';

const PLAN_CASHIER_LIMIT: Record<PlanTier, number> = {
  free: 1,
  starter: 2,
  pro: 5,
  business: 10,
};

const INVITE_TTL_HOURS = 72;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

type CashierLimitMeta = {
  plan: PlanTier;
  limit: number;
  used: number;
  base: number;
  addons: number;
};

// Coded failure returned (not thrown) so the structured payload survives Next's
// production error masking; the client renders the upgrade CTA from `meta`.
function cashiersLimitReached(
  meta: CashierLimitMeta,
): { ok: false; error: string; code: string; meta: CashierLimitMeta } {
  return {
    ok: false,
    error: `Alcanzaste el límite de usuarios de tu plan (${meta.used}/${meta.limit}).`,
    code: CASHIERS_LIMIT_REACHED,
    meta,
  };
}

async function requireAdminContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage employees');
  }
  return { userId, orgId };
}

async function getOrganizationPlan(orgId: string): Promise<PlanTier> {
  const [row] = await db
    .select({ plan: organizationPlansSchema.plan })
    .from(organizationPlansSchema)
    .where(eq(organizationPlansSchema.organizationId, orgId))
    .limit(1);
  return (row?.plan as PlanTier | undefined) ?? 'free';
}

async function countCashierAddons(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(planAddonsSchema)
    .where(
      and(
        eq(planAddonsSchema.organizationId, orgId),
        eq(planAddonsSchema.addon, 'pos_cashier'),
        eq(planAddonsSchema.active, true),
      ),
    );
  return Number(row?.value ?? 0);
}

// Counts every active user of the org. There are no role tiers anymore: the
// plan seat limit applies to all business users (the owner is a Clerk member,
// not a posUser, so they never consume a seat).
async function countActiveUsers(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
      ),
    );
  return Number(row?.value ?? 0);
}

export type CashierQuota = {
  plan: PlanTier;
  used: number;
  base: number;
  addons: number;
  limit: number;
  remaining: number;
};

// Read-only snapshot of employee (cashier user) usage for the Resumen counter.
// Mirrors getPosDeviceQuota's shape so the dashboard can render both quotas the
// same way. Not admin-gated: it only reads counts, never mutates, so any member
// of the org can see how many seats are used without hitting a 403.
export async function getCashierQuota(): Promise<CashierQuota> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No active organization');
  }

  const [plan, used, addons] = await Promise.all([
    getOrganizationPlan(orgId),
    countActiveUsers(orgId),
    countCashierAddons(orgId),
  ]);
  const base = PLAN_CASHIER_LIMIT[plan];
  const limit = base + addons;

  return {
    plan,
    used,
    base,
    addons,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

function buildInviteUrl(token: string, userId: string): string {
  const base
    = process.env.FRONTEND_URL
      ?? Env.NEXT_PUBLIC_APP_URL
      ?? 'http://localhost:3000';
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/accept-invitation?token=${token}&userId=${userId}`;
}

export type InviteEmployeeInput = {
  email: string;
  name: string;
  role?: 'admin' | 'cashier' | 'employee';
  permissions?: Record<string, unknown>;
  enabledModules?: string[];
  canConfirmTransfers?: boolean;
};

export type InviteEmployeeResult = {
  invitation: typeof employeeInvitationsSchema.$inferSelect;
  inviteUrl: string;
  emailSent: false;
};

export async function invite(
  data: InviteEmployeeInput,
): Promise<ActionResult<InviteEmployeeResult>> {
  const { userId, orgId } = await requireAdminContext();

  const email = data.email?.trim().toLowerCase();
  const name = data.name?.trim();
  // Role tiers are retired: every invited person is a plain business user whose
  // access is defined entirely by the granted permissions/modules.
  const role = data.role ?? 'employee';
  const enabledModules = cleanEnabledModules(data.enabledModules);
  const permissions = cleanActionPermissions(
    data.permissions as Record<string, unknown> | undefined,
  );

  if (!email || !/^\S[^\s@]*@\S[^\s.]*\.\S+$/.test(email)) {
    return { ok: false, error: 'Ingresá un email válido' };
  }
  if (!name) {
    return { ok: false, error: 'El nombre es obligatorio' };
  }

  // 1. Seat quota check — applies to every user (no role exemptions).
  {
    const [plan, used, addons] = await Promise.all([
      getOrganizationPlan(orgId),
      countActiveUsers(orgId),
      countCashierAddons(orgId),
    ]);
    const base = PLAN_CASHIER_LIMIT[plan];
    const limit = base + addons;

    if (used >= limit) {
      return cashiersLimitReached({ plan, limit, used, base, addons });
    }
  }

  // 3. Validate email is not already in use as a posUser.
  const [existing] = await db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(eq(posUsersSchema.email, email))
    .limit(1);
  if (existing) {
    return { ok: false, error: 'Ya existe un usuario con ese email' };
  }

  // 4–6. Create posUser + invitation in a single transaction.
  const tempPassword = randomUUID();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(posUsersSchema)
      .values({
        organizationId: orgId,
        name,
        email,
        passwordHash,
        role,
        active: false,
        permissions,
        enabledModules,
        canConfirmTransfers: data.canConfirmTransfers ?? true,
      })
      .returning();

    if (!user) {
      throw new Error('Failed to create user');
    }

    const [invitation] = await tx
      .insert(employeeInvitationsSchema)
      .values({
        organizationId: orgId,
        userId: user.id,
        email,
        name,
        role,
        token,
        expiresAt,
        status: 'pending',
        permissions,
        enabledModules,
        canConfirmTransfers: data.canConfirmTransfers ?? true,
      })
      .returning();

    if (!invitation) {
      throw new Error('Failed to create invitation');
    }

    return { user, invitation };
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'employee.invited',
    entityType: 'employee_invitation',
    entityId: result.invitation.id,
    after: {
      invitationId: result.invitation.id,
      userId: result.user.id,
      email: result.invitation.email,
      name: result.invitation.name,
      role: result.invitation.role,
      enabledModules: result.invitation.enabledModules,
    },
  });

  revalidatePath('/dashboard/employees');

  return {
    ok: true,
    data: {
      invitation: result.invitation,
      inviteUrl: buildInviteUrl(result.invitation.token, result.user.id),
      emailSent: false,
    },
  };
}

export type AcceptInvitationInput = {
  token: string;
  name: string;
  password: string;
};

export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<ActionResult<{ organizationId: string }>> {
  const token = input.token?.trim();
  const name = input.name?.trim();
  const password = input.password;

  if (!token) {
    return { ok: false, error: 'El enlace de invitación no es válido' };
  }
  if (!name) {
    return { ok: false, error: 'El nombre es obligatorio' };
  }
  if (!password || password.length < 8) {
    return { ok: false, error: 'La contraseña debe tener al menos 8 caracteres' };
  }

  const [invitation] = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(eq(employeeInvitationsSchema.token, token))
    .limit(1);

  if (!invitation) {
    return { ok: false, error: 'Invitación no encontrada' };
  }
  if (invitation.status !== 'pending') {
    return { ok: false, error: 'Esta invitación ya no está disponible' };
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await db
      .update(employeeInvitationsSchema)
      .set({ status: 'expired' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));
    return { ok: false, error: 'La invitación expiró' };
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await db.transaction(async (tx) => {
    await tx
      .update(posUsersSchema)
      .set({
        name,
        passwordHash,
        active: true,
      })
      .where(eq(posUsersSchema.id, invitation.userId));

    await tx
      .update(employeeInvitationsSchema)
      .set({ status: 'accepted' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));
  });

  await logAction({
    organizationId: invitation.organizationId,
    actor: { type: 'cashier', id: invitation.userId },
    action: 'invitation.accepted',
    entityType: 'employee_invitation',
    entityId: invitation.id,
    before: { status: 'pending' },
    after: {
      invitationId: invitation.id,
      userId: invitation.userId,
      email: invitation.email,
      role: invitation.role,
      acceptedName: name,
    },
  });

  return { ok: true, data: { organizationId: invitation.organizationId } };
}

export async function listEmployees() {
  const { orgId } = await requireAdminContext();

  const rows = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      email: posUsersSchema.email,
      role: posUsersSchema.role,
      active: posUsersSchema.active,
      enabledModules: posUsersSchema.enabledModules,
      permissions: posUsersSchema.permissions,
      canConfirmTransfers: posUsersSchema.canConfirmTransfers,
      hasPin: sql<boolean>`(${posUsersSchema.pin} <> '')`,
      createdAt: posUsersSchema.createdAt,
    })
    .from(posUsersSchema)
    .where(eq(posUsersSchema.organizationId, orgId))
    .orderBy(desc(posUsersSchema.createdAt));

  return rows;
}

export async function listPendingInvitations() {
  const { orgId } = await requireAdminContext();

  const rows = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(
      and(
        eq(employeeInvitationsSchema.organizationId, orgId),
        eq(employeeInvitationsSchema.status, 'pending'),
      ),
    )
    .orderBy(desc(employeeInvitationsSchema.createdAt));

  return rows.map(r => ({
    ...r,
    inviteUrl: buildInviteUrl(r.token, r.userId),
    expired: r.expiresAt.getTime() <= Date.now(),
  }));
}

export async function revokeInvitation(
  invitationId: string,
): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireAdminContext();

  const [invitation] = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(
      and(
        eq(employeeInvitationsSchema.id, invitationId),
        eq(employeeInvitationsSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!invitation) {
    return { ok: false, error: 'Invitación no encontrada' };
  }
  if (invitation.status !== 'pending') {
    return { ok: false, error: 'Esta invitación ya no está pendiente' };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(employeeInvitationsSchema)
      .set({ status: 'revoked' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));

    await tx
      .update(posUsersSchema)
      .set({ active: false })
      .where(eq(posUsersSchema.id, invitation.userId));
  });

  revalidatePath('/dashboard/employees');
  return { ok: true, data: { id: invitation.id } };
}

export type ResendInvitationResult = {
  invitation: typeof employeeInvitationsSchema.$inferSelect;
  inviteUrl: string;
  emailSent: false;
};

export async function resendInvitation(
  invitationId: string,
): Promise<ActionResult<ResendInvitationResult>> {
  const { orgId } = await requireAdminContext();

  const [invitation] = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(
      and(
        eq(employeeInvitationsSchema.id, invitationId),
        eq(employeeInvitationsSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!invitation) {
    return { ok: false, error: 'Invitación no encontrada' };
  }
  if (invitation.status === 'accepted') {
    return { ok: false, error: 'La invitación ya fue aceptada' };
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [updated] = await db
    .update(employeeInvitationsSchema)
    .set({ token, expiresAt, status: 'pending' })
    .where(eq(employeeInvitationsSchema.id, invitation.id))
    .returning();

  if (!updated) {
    throw new Error('Failed to resend invitation');
  }

  revalidatePath('/dashboard/employees');

  return {
    ok: true,
    data: {
      invitation: updated,
      inviteUrl: buildInviteUrl(updated.token, updated.userId),
      emailSent: false,
    },
  };
}

// El admin resetea el PIN de un empleado (lo deja sin PIN). El empleado podrá
// configurar uno nuevo desde la caja. `pin = ''` → sin PIN (acceso directo).
export async function resetCashierPin(
  cashierId: string,
): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireAdminContext();

  const [updated] = await db
    .update(posUsersSchema)
    .set({ pin: '' })
    .where(
      and(
        eq(posUsersSchema.id, cashierId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posUsersSchema.id });

  if (!updated) {
    return { ok: false, error: 'Empleado no encontrado' };
  }

  revalidatePath('/dashboard/employees');
  return { ok: true, data: updated };
}

export type UpdateEmployeeInput = {
  permissions?: Record<string, unknown>;
  enabledModules?: string[];
  canConfirmTransfers?: boolean;
};

// Permissions are DYNAMIC: the owner can change what a user can see/do at any
// time. This rewrites the granted modules/permissions for an existing user.
export async function updateEmployee(
  userId: string,
  input: UpdateEmployeeInput,
): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId: actorId } = await requireAdminContext();

  const [existing] = await db
    .select({
      id: posUsersSchema.id,
      permissions: posUsersSchema.permissions,
      enabledModules: posUsersSchema.enabledModules,
      canConfirmTransfers: posUsersSchema.canConfirmTransfers,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, userId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { ok: false, error: 'Empleado no encontrado' };
  }

  const enabledModules = cleanEnabledModules(
    input.enabledModules ?? existing.enabledModules,
  );
  const permissions = cleanActionPermissions(
    (input.permissions
      ?? existing.permissions) as Record<string, unknown> | undefined,
  );
  const canConfirmTransfers
    = input.canConfirmTransfers ?? existing.canConfirmTransfers;

  const [updated] = await db
    .update(posUsersSchema)
    .set({ permissions, enabledModules, canConfirmTransfers })
    .where(
      and(
        eq(posUsersSchema.id, userId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posUsersSchema.id });

  if (!updated) {
    return { ok: false, error: 'Empleado no encontrado' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: actorId },
    action: 'employee.permissions_updated',
    entityType: 'pos_user',
    entityId: userId,
    before: {
      enabledModules: existing.enabledModules,
      permissions: existing.permissions,
      canConfirmTransfers: existing.canConfirmTransfers,
    },
    after: { enabledModules, permissions, canConfirmTransfers },
  });

  revalidatePath('/dashboard/employees');
  return { ok: true, data: updated };
}

// Deactivating frees a plan seat without deleting history; reactivating
// re-checks the seat quota so the owner can't exceed their plan.
export async function setEmployeeActive(
  userId: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId: actorId } = await requireAdminContext();

  if (active) {
    const [plan, used, addons] = await Promise.all([
      getOrganizationPlan(orgId),
      countActiveUsers(orgId),
      countCashierAddons(orgId),
    ]);
    const base = PLAN_CASHIER_LIMIT[plan];
    const limit = base + addons;
    if (used >= limit) {
      return cashiersLimitReached({ plan, limit, used, base, addons });
    }
  }

  const [updated] = await db
    .update(posUsersSchema)
    .set({ active })
    .where(
      and(
        eq(posUsersSchema.id, userId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posUsersSchema.id });

  if (!updated) {
    return { ok: false, error: 'Empleado no encontrado' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: actorId },
    action: active ? 'employee.reactivated' : 'employee.deactivated',
    entityType: 'pos_user',
    entityId: userId,
    after: { active },
  });

  revalidatePath('/dashboard/employees');
  return { ok: true, data: updated };
}
