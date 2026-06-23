import type { db } from '@/libs/DB';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { posUsersSchema } from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OwnerIdentity = {
  clerkUserId: string;
  email: string;
  name: string;
};

/**
 * Ensures the org owner exists as an ADMIN operator (`pos_users` row) so they
 * show up in the device "¿quién sos?" selector and can be the DEFAULT operator
 * of a caja. The owner is normally a Clerk-only member with no `pos_users` row
 * (see libs/panel-session.ts), so a caja used to open with no person and the
 * "Responsable" fell back to the caja name. This provisions (or reuses/repairs)
 * a real person instead.
 *
 * Idempotent: reuses the operator linked by `clerkUserId`, else one matching the
 * owner email (linking it), else creates a fresh admin operator. When `pin` is
 * given AND the operator has no PIN yet, it is set — an existing PIN is never
 * silently overwritten here (the owner changes it from set-pin).
 *
 * The owner-admin operator does NOT consume a paid cashier seat — see
 * `countActiveUsers` in actions/employees.ts, which excludes `role = 'admin'`.
 */
export async function ensureOwnerCashier(
  executor: Executor,
  orgId: string,
  owner: OwnerIdentity,
  pin?: string,
): Promise<{ id: string; name: string }> {
  const pinTrim = pin?.trim();

  const linkAdmin = async (
    row: { id: string; name: string; active: boolean; role: string; pin: string },
  ): Promise<{ id: string; name: string }> => {
    const updates: Record<string, unknown> = {};
    if (!row.active) {
      updates.active = true;
    }
    if (row.role !== 'admin') {
      updates.role = 'admin';
    }
    if (pinTrim && !row.pin) {
      updates.pin = await bcrypt.hash(pinTrim, 10);
    }
    if (Object.keys(updates).length > 0) {
      await executor
        .update(posUsersSchema)
        .set(updates)
        .where(eq(posUsersSchema.id, row.id));
    }
    return { id: row.id, name: row.name };
  };

  // 1. Already linked by Clerk identity → reuse.
  const [byClerk] = await executor
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      active: posUsersSchema.active,
      role: posUsersSchema.role,
      pin: posUsersSchema.pin,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.clerkUserId, owner.clerkUserId),
      ),
    )
    .limit(1);
  if (byClerk) {
    return linkAdmin(byClerk);
  }

  // 2. A row with the owner email but not yet linked → adopt + link it.
  const email = owner.email.trim().toLowerCase();
  if (email) {
    const [byEmail] = await executor
      .select({
        id: posUsersSchema.id,
        name: posUsersSchema.name,
        active: posUsersSchema.active,
        role: posUsersSchema.role,
        pin: posUsersSchema.pin,
      })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.organizationId, orgId),
          eq(posUsersSchema.email, email),
        ),
      )
      .limit(1);
    if (byEmail) {
      await executor
        .update(posUsersSchema)
        .set({ clerkUserId: owner.clerkUserId })
        .where(eq(posUsersSchema.id, byEmail.id));
      return linkAdmin(byEmail);
    }
  }

  // 3. Fresh admin operator for the owner. Email is required + must be unique per
  // org; fall back to a synthetic address when Clerk has none.
  const safeEmail = email || `owner-${owner.clerkUserId}@operator.local`;
  const [created] = await executor
    .insert(posUsersSchema)
    .values({
      organizationId: orgId,
      name: owner.name.trim() || 'Administrador',
      email: safeEmail,
      passwordHash: await bcrypt.hash(randomUUID(), 10),
      pin: pinTrim ? await bcrypt.hash(pinTrim, 10) : '',
      role: 'admin',
      active: true,
      clerkUserId: owner.clerkUserId,
      panelAccess: true,
    })
    .returning({ id: posUsersSchema.id, name: posUsersSchema.name });

  if (!created) {
    throw new Error('Failed to provision owner operator');
  }
  return created;
}
