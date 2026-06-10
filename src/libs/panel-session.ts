import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { canAccessModule } from '@/libs/permissions';
import { posUsersSchema } from '@/models/Schema';

/**
 * Resolves the allowed dashboard modules for a non-owner panel user, looked up
 * by their linked Clerk identity. The database is the source of truth for
 * authorization (the Clerk membership metadata is only a cache).
 *
 * Returns `null` when there is no ACTIVE linked business user for that Clerk id
 * in the org — callers treat null as deny-by-default (no modules).
 */
export async function getPanelUserModules(
  clerkUserId: string,
  organizationId: string,
): Promise<string[] | null> {
  const [row] = await db
    .select({ enabledModules: posUsersSchema.enabledModules })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.clerkUserId, clerkUserId),
        eq(posUsersSchema.organizationId, organizationId),
        eq(posUsersSchema.active, true),
      ),
    )
    .limit(1);

  return row ? (row.enabledModules ?? []) : null;
}

/**
 * Backend authorization gate for a panel module (decision: validate on the
 * server too, not only by hiding views). The owner (Clerk org admin) passes
 * unconditionally; a non-owner member must hold the module in the DB (source of
 * truth). Throws `forbidden_module` otherwise. Returns the resolved ids so
 * callers can keep using them like the local requireOrg helpers do.
 */
export async function requirePanelModule(
  moduleKey: string,
): Promise<{ userId: string; orgId: string }> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole === 'org:admin') {
    return { userId, orgId };
  }
  const modules = await getPanelUserModules(userId, orgId);
  if (!canAccessModule(modules, moduleKey)) {
    throw new Error('forbidden_module');
  }
  return { userId, orgId };
}
