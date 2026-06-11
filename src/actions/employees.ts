'use server';

import type { ActionResult } from '@/libs/action-result';
import { randomUUID } from 'node:crypto';
import { auth, clerkClient } from '@clerk/nextjs/server';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { sendInvitationEmail } from '@/libs/email';
import { getOrgEntitlements, limitOf } from '@/libs/entitlements';
import { Env } from '@/libs/Env';
import { syncPanelModules } from '@/libs/panel-access';
import {
  cleanActionPermissions,
  cleanEnabledModules,
} from '@/libs/permissions';
import { CASHIERS_LIMIT_REACHED } from '@/libs/plan-limits';
import {
  cashMovementsSchema,
  deliveryOrdersSchema,
  employeeInvitationsSchema,
  planAddonsSchema,
  posReturnsSchema,
  posTokensSchema,
  posUsersSchema,
  salesSchema,
} from '@/models/Schema';

const INVITE_TTL_HOURS = 72;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

type CashierLimitMeta = {
  plan: string;
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
  plan: string;
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

  const [entitlements, used, addons] = await Promise.all([
    getOrgEntitlements(orgId),
    countActiveUsers(orgId),
    countCashierAddons(orgId),
  ]);
  const plan = entitlements.planSlug;
  const base = limitOf(entitlements, 'max_cashiers', 1);
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

/** Clerk organization name for emails; null if it can't be resolved. */
async function resolveOrgName(orgId: string): Promise<string | null> {
  try {
    const org = await (await clerkClient()).organizations.getOrganization({
      organizationId: orgId,
    });
    return org.name;
  } catch {
    return null;
  }
}

export type InviteEmployeeInput = {
  email: string;
  name: string;
  role?: 'admin' | 'cashier' | 'employee';
  permissions?: Record<string, unknown>;
  enabledModules?: string[];
  canConfirmTransfers?: boolean;
  // Whether this single user may sign into the web panel. Independent from the
  // module grants above (a panel user can still see only Inventario, etc.).
  panelAccess?: boolean;
};

export type InviteEmployeeResult = {
  invitation: typeof employeeInvitationsSchema.$inferSelect;
  inviteUrl: string;
  emailSent: boolean;
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
  const panelAccess = data.panelAccess ?? false;

  if (!email || !/^\S[^\s@]*@\S[^\s.]*\.\S+$/.test(email)) {
    return { ok: false, error: 'Ingresá un email válido' };
  }
  if (!name) {
    return { ok: false, error: 'El nombre es obligatorio' };
  }

  // 1. Seat quota check — applies to every user (no role exemptions).
  {
    const [entitlements, used, addons] = await Promise.all([
      getOrgEntitlements(orgId),
      countActiveUsers(orgId),
      countCashierAddons(orgId),
    ]);
    const plan = entitlements.planSlug;
    const base = limitOf(entitlements, 'max_cashiers', 1);
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
        panelAccess,
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
        panelAccess,
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

  const inviteUrl = buildInviteUrl(result.invitation.token, result.user.id);
  const emailSent = await sendInvitationEmail({
    to: result.invitation.email,
    name: result.invitation.name,
    organizationName: await resolveOrgName(orgId),
    inviteUrl,
  });

  revalidatePath('/dashboard/employees');

  return {
    ok: true,
    data: {
      invitation: result.invitation,
      inviteUrl,
      emailSent,
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
      salary: posUsersSchema.salary,
      phone: posUsersSchema.phone,
      workSchedule: posUsersSchema.workSchedule,
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
  emailSent: boolean;
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

  const inviteUrl = buildInviteUrl(updated.token, updated.userId);
  const emailSent = await sendInvitationEmail({
    to: updated.email,
    name: updated.name,
    organizationName: await resolveOrgName(orgId),
    inviteUrl,
  });

  revalidatePath('/dashboard/employees');

  return {
    ok: true,
    data: {
      invitation: updated,
      inviteUrl,
      emailSent,
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

export type WorkDaySchedule = {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  off: boolean; // true = rest day; start/end ignored
};

export type WorkSchedule = Partial<
  Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', WorkDaySchedule>
>;

export type UpdateEmployeeInput = {
  permissions?: Record<string, unknown>;
  enabledModules?: string[];
  canConfirmTransfers?: boolean;
  /** Monthly gross salary. Must be >= 0 when provided. */
  salary?: number | null;
  /** Contact phone number. */
  phone?: string | null;
  /** Partial weekly work schedule keyed by weekday code. */
  workSchedule?: WorkSchedule | null;
};

// Permissions are DYNAMIC: the owner can change what a user can see/do at any
// time. This rewrites the granted modules/permissions for an existing user.
export async function updateEmployee(
  userId: string,
  input: UpdateEmployeeInput,
): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId: actorId } = await requireAdminContext();

  if (input.salary != null && (!Number.isFinite(input.salary) || input.salary < 0)) {
    return { ok: false, error: 'El salario debe ser 0 o mayor' };
  }

  const [existing] = await db
    .select({
      id: posUsersSchema.id,
      permissions: posUsersSchema.permissions,
      enabledModules: posUsersSchema.enabledModules,
      canConfirmTransfers: posUsersSchema.canConfirmTransfers,
      clerkUserId: posUsersSchema.clerkUserId,
      salary: posUsersSchema.salary,
      phone: posUsersSchema.phone,
      workSchedule: posUsersSchema.workSchedule,
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

  // salary: explicit null clears it; undefined keeps existing; number sets it.
  const salary = input.salary !== undefined
    ? (input.salary != null ? String(input.salary) : null)
    : existing.salary;
  const phone = input.phone !== undefined ? input.phone : existing.phone;

  // workSchedule sanitization: must be an object if provided (null clears it).
  // For each weekday key, coerce to { start, end, off } — drop invalid time
  // fields (keep `off`) so garbage from clients never reaches the DB.
  const TIME_RE = /^\d{2}:\d{2}$/;
  const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  let workSchedule: WorkSchedule | null | typeof existing.workSchedule;
  if (input.workSchedule === undefined) {
    workSchedule = existing.workSchedule;
  } else if (input.workSchedule === null) {
    workSchedule = null;
  } else if (typeof input.workSchedule !== 'object' || Array.isArray(input.workSchedule)) {
    return { ok: false, error: 'El horario semanal no tiene un formato válido' };
  } else {
    const cleaned: WorkSchedule = {};
    for (const k of WEEKDAY_KEYS) {
      const raw = (input.workSchedule as WorkSchedule)[k];
      if (!raw) {
        continue;
      }
      const off = Boolean(raw.off);
      const start = TIME_RE.test(raw.start ?? '') ? raw.start : undefined;
      const end = TIME_RE.test(raw.end ?? '') ? raw.end : undefined;
      cleaned[k] = { off, start: start ?? '08:00', end: end ?? '17:00' };
    }
    workSchedule = cleaned;
  }

  const [updated] = await db
    .update(posUsersSchema)
    .set({ permissions, enabledModules, canConfirmTransfers, salary, phone, workSchedule })
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
    action: 'employee.updated',
    entityType: 'pos_user',
    entityId: userId,
    before: {
      enabledModules: existing.enabledModules,
      permissions: existing.permissions,
      canConfirmTransfers: existing.canConfirmTransfers,
      salary: existing.salary,
      phone: existing.phone,
    },
    after: { enabledModules, permissions, canConfirmTransfers, salary, phone },
  });

  // Source of truth is the DB; push the new modules to the Clerk membership
  // cache so the panel middleware authorizes the change immediately. Best-effort:
  // a Clerk hiccup must not fail the DB write that already succeeded.
  if (existing.clerkUserId) {
    try {
      await syncPanelModules(orgId, existing.clerkUserId, enabledModules);
    } catch {
      // DB stays authoritative; the next edit (or a reconcile) will resync.
    }
  }

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
    const [entitlements, used, addons] = await Promise.all([
      getOrgEntitlements(orgId),
      countActiveUsers(orgId),
      countCashierAddons(orgId),
    ]);
    const plan = entitlements.planSlug;
    const base = limitOf(entitlements, 'max_cashiers', 1);
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

// Permanently removes an employee with NO operational history from the org.
// Employees with linked records (sales, tokens, returns, deliveries, cash movements)
// must be deactivated instead — this guard prevents orphaned data integrity issues.
export async function deleteEmployee(
  employeeId: string,
): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId: actorId } = await requireAdminContext();

  const [target] = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      role: posUsersSchema.role,
      clerkUserId: posUsersSchema.clerkUserId,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, employeeId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!target) {
    return { ok: false, error: 'Empleado no encontrado' };
  }

  // C1 — Cannot delete yourself. Compare against the Clerk userId, not the
  // pos_users UUID — actorId comes from Clerk's auth() and target.id is a
  // pos_users UUID, so the old comparison was always false.
  if (target.clerkUserId && target.clerkUserId === actorId) {
    return { ok: false, error: 'No podés eliminar tu propia cuenta', code: 'self_delete' };
  }

  // History check — refuse hard-delete if the employee has any operational records.
  //
  // C3 — sales.cashier_id is TEXT (not UUID FK). POS sales store the pos_users
  // UUID; web-dashboard (panel) sales store the Clerk userId. Match both so
  // panel-access employees are not invisible to this guard.
  //
  // C2 — cash_movements.created_by and authorized_by are TEXT columns storing
  // the actor's NAME (e.g. "Juan López", "Cajero"), NOT a UUID. Matching by
  // UUID always returns 0. Guard by name instead — conservative: if anyone
  // recorded a movement under this employee's name, block the hard-delete.
  const [
    salesCount,
    tokensCount,
    returnsCount,
    deliveriesCount,
    movementsCount,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(salesSchema)
      .where(
        and(
          eq(salesSchema.organizationId, orgId),
          target.clerkUserId
            ? or(
                eq(salesSchema.cashierId, employeeId),
                eq(salesSchema.cashierId, target.clerkUserId),
              )
            : eq(salesSchema.cashierId, employeeId),
        ),
      ),
    db
      .select({ value: count() })
      .from(posTokensSchema)
      .where(
        and(
          eq(posTokensSchema.organizationId, orgId),
          eq(posTokensSchema.cashierId, employeeId),
        ),
      ),
    db
      .select({ value: count() })
      .from(posReturnsSchema)
      .where(
        and(
          eq(posReturnsSchema.organizationId, orgId),
          eq(posReturnsSchema.cashierId, employeeId),
        ),
      ),
    db
      .select({ value: count() })
      .from(deliveryOrdersSchema)
      .where(
        and(
          eq(deliveryOrdersSchema.organizationId, orgId),
          eq(deliveryOrdersSchema.courierId, employeeId),
        ),
      ),
    // cash_movements.created_by and authorized_by store the actor's display
    // NAME as plain TEXT, not a UUID — match by name (conservative guard).
    db
      .select({ value: count() })
      .from(cashMovementsSchema)
      .where(
        and(
          eq(cashMovementsSchema.organizationId, orgId),
          or(
            eq(cashMovementsSchema.createdBy, target.name),
            eq(cashMovementsSchema.authorizedBy, target.name),
          ),
        ),
      ),
  ]);

  const hasHistory
    = Number(salesCount[0]?.value ?? 0) > 0
      || Number(tokensCount[0]?.value ?? 0) > 0
      || Number(returnsCount[0]?.value ?? 0) > 0
      || Number(deliveriesCount[0]?.value ?? 0) > 0
      || Number(movementsCount[0]?.value ?? 0) > 0;

  if (hasHistory) {
    return {
      ok: false,
      error:
        'Este empleado tiene historial operativo (ventas, movimientos o entregas). '
        + 'Desactivalo en su lugar para conservar los registros.',
      code: 'has_history',
    };
  }

  // W3 + W4 — Delete in a transaction FIRST; Clerk cleanup is best-effort AFTER.
  // Deleting the pos_users row already revokes access (middleware uses pos_users
  // as source of truth). The transaction also re-counts active admins if the
  // target is an admin (last-admin TOCTOU guard).
  let lastAdminBlocked = false;

  await db.transaction(async (tx) => {
    // W4 — Re-count active admins inside the transaction to close the TOCTOU
    // window between the pre-check above and the actual delete.
    if (target.role === 'admin') {
      const [adminCount] = await tx
        .select({ value: count() })
        .from(posUsersSchema)
        .where(
          and(
            eq(posUsersSchema.organizationId, orgId),
            eq(posUsersSchema.role, 'admin'),
            eq(posUsersSchema.active, true),
          ),
        );
      if (Number(adminCount?.value ?? 0) <= 1) {
        lastAdminBlocked = true;
        // Throwing rolls back the transaction; we catch and convert below.
        const err = new Error('No se puede eliminar al último administrador activo de la organización');
        (err as Error & { code: string }).code = 'last_admin';
        throw err;
      }
    }

    await tx
      .delete(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.id, employeeId),
          eq(posUsersSchema.organizationId, orgId),
        ),
      );
  }).catch((err: unknown) => {
    // Re-throw everything that isn't our controlled rollback signal.
    if (!lastAdminBlocked) {
      throw err;
    }
  });

  if (lastAdminBlocked) {
    return {
      ok: false,
      error: 'No se puede eliminar al último administrador activo de la organización',
      code: 'last_admin',
    };
  }

  // W3 — Clerk cleanup is best-effort AFTER the DB delete succeeds. A Clerk
  // hiccup never desynchronizes or blocks the delete that already committed.
  if (target.clerkUserId) {
    try {
      const client = await clerkClient();
      await client.organizations.deleteOrganizationMembership({
        organizationId: orgId,
        userId: target.clerkUserId,
      });
    } catch {
      // Best-effort: Clerk membership removal; DB delete already committed.
    }
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: actorId },
    action: 'employee.deleted',
    entityType: 'pos_user',
    entityId: employeeId,
    before: { name: target.name, role: target.role },
    after: { deleted: true },
  });

  revalidatePath('/dashboard/employees');
  return { ok: true, data: { id: employeeId } };
}
