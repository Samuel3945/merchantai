import type { db } from '@/libs/DB';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, or, sql } from 'drizzle-orm';
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
          // Case-insensitive: el admin (primer empleado) puede tener el email con
          // otra capitalización; igual lo adoptamos en vez de crear un duplicado.
          sql`LOWER(${posUsersSchema.email}) = ${email}`,
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

  // 3. Fresh admin operator for the owner. Its email is only a unique key for the
  // row — the owner signs into the PANEL via Clerk, never via this POS login — so
  // use a SYNTHETIC address derived from the Clerk id. pos_users.email is UNIQUE
  // GLOBALLY (not per-org): inserting the owner's REAL email could collide with a
  // pos_user that email already has in another org and break caja creation. The
  // synthetic address is unique per Clerk id, so it never collides. A real-email
  // row in THIS org is still adopted above (step 2) before reaching here.
  const operatorEmail = `owner-${owner.clerkUserId}@operator.local`;
  const [created] = await executor
    .insert(posUsersSchema)
    .values({
      organizationId: orgId,
      name: owner.name.trim() || 'Administrador',
      email: operatorEmail,
      passwordHash: await bcrypt.hash(randomUUID(), 10),
      pin: pinTrim ? await bcrypt.hash(pinTrim, 10) : '',
      role: 'admin',
      active: true,
      clerkUserId: owner.clerkUserId,
      panelAccess: true,
    })
    // pos_users.email es UNIQUE GLOBAL. Si el operador del dueño ya existe (creado
    // en el onboarding como primer empleado, en paralelo, o en un intento previo),
    // NO reventamos con 500: saltamos el insert y reutilizamos la fila de abajo.
    .onConflictDoNothing()
    .returning({ id: posUsersSchema.id, name: posUsersSchema.name });

  if (created) {
    return created;
  }

  // Hubo conflicto → el dueño ya tiene su operador. Lo buscamos (por Clerk id o por
  // el email sintético) y lo reutilizamos como admin, sin crear un perfil nuevo.
  const [existing] = await executor
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
        or(
          eq(posUsersSchema.clerkUserId, owner.clerkUserId),
          eq(posUsersSchema.email, operatorEmail),
        ),
      ),
    )
    .limit(1);
  if (existing) {
    return linkAdmin(existing);
  }

  throw new Error('Failed to provision owner operator');
}
