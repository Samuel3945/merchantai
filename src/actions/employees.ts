'use server';

import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
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

export class CashiersLimitReachedError extends Error {
  readonly statusCode = 402;
  readonly code = 'cashiers_limit_reached';
  readonly plan: PlanTier;
  readonly limit: number;
  readonly used: number;
  readonly base: number;
  readonly addons: number;

  constructor(payload: {
    plan: PlanTier;
    limit: number;
    used: number;
    base: number;
    addons: number;
  }) {
    super(
      `Cashiers limit reached: ${payload.used}/${payload.limit} on plan "${payload.plan}".`,
    );
    this.name = 'CashiersLimitReachedError';
    this.plan = payload.plan;
    this.limit = payload.limit;
    this.used = payload.used;
    this.base = payload.base;
    this.addons = payload.addons;
  }

  toJSON() {
    return {
      code: this.code,
      plan: this.plan,
      limit: this.limit,
      used: this.used,
      base: this.base,
      addons: this.addons,
    };
  }
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

async function countActiveCashiers(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.role, 'cashier'),
        eq(posUsersSchema.active, true),
      ),
    );
  return Number(row?.value ?? 0);
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
): Promise<InviteEmployeeResult> {
  const { userId, orgId } = await requireAdminContext();

  const email = data.email?.trim().toLowerCase();
  const name = data.name?.trim();
  const role = data.role ?? 'cashier';

  if (!email || !/^\S[^\s@]*@\S[^\s.]*\.\S+$/.test(email)) {
    throw new Error('A valid email is required');
  }
  if (!name) {
    throw new Error('Name is required');
  }

  // 1. Quota check (only enforced for cashiers; admins/employees not gated here).
  if (role === 'cashier') {
    const [plan, used, addons] = await Promise.all([
      getOrganizationPlan(orgId),
      countActiveCashiers(orgId),
      countCashierAddons(orgId),
    ]);
    const base = PLAN_CASHIER_LIMIT[plan];
    const limit = base + addons;

    if (used >= limit) {
      throw new CashiersLimitReachedError({
        plan,
        limit,
        used,
        base,
        addons,
      });
    }
  }

  // 3. Validate email is not already in use as a posUser.
  const [existing] = await db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(eq(posUsersSchema.email, email))
    .limit(1);
  if (existing) {
    throw new Error('A user with that email already exists');
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
        permissions: data.permissions ?? {},
        enabledModules: data.enabledModules ?? ['pos'],
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
        permissions: data.permissions ?? {},
        enabledModules: data.enabledModules ?? ['pos'],
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
    invitation: result.invitation,
    inviteUrl: buildInviteUrl(result.invitation.token, result.user.id),
    emailSent: false,
  };
}

export type AcceptInvitationInput = {
  token: string;
  name: string;
  password: string;
};

export async function acceptInvitation(input: AcceptInvitationInput) {
  const token = input.token?.trim();
  const name = input.name?.trim();
  const password = input.password;

  if (!token) {
    throw new Error('Token is required');
  }
  if (!name) {
    throw new Error('Name is required');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const [invitation] = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(eq(employeeInvitationsSchema.token, token))
    .limit(1);

  if (!invitation) {
    throw new Error('Invitation not found');
  }
  if (invitation.status !== 'pending') {
    throw new Error(`Invitation is ${invitation.status}`);
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await db
      .update(employeeInvitationsSchema)
      .set({ status: 'expired' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));
    throw new Error('Invitation has expired');
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

  return { ok: true as const, organizationId: invitation.organizationId };
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
      canConfirmTransfers: posUsersSchema.canConfirmTransfers,
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

export async function revokeInvitation(invitationId: string) {
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
    throw new Error('Invitation not found');
  }
  if (invitation.status !== 'pending') {
    throw new Error(`Invitation is ${invitation.status}`);
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
  return { ok: true as const };
}

export async function resendInvitation(invitationId: string) {
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
    throw new Error('Invitation not found');
  }
  if (invitation.status === 'accepted') {
    throw new Error('Invitation already accepted');
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
    invitation: updated,
    inviteUrl: buildInviteUrl(updated.token, updated.userId),
    emailSent: false as const,
  };
}
