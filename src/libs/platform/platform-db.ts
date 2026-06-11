import { db as rawDb } from '@/libs/DB';
import { requirePlatformOperator } from '@/libs/platform/operator';

/**
 * Cross-tenant database access for the operator console.
 *
 * Tenant code must keep using `db()` from libs/db-context.ts, which scopes
 * every query to the session org. This module is the ONLY sanctioned door to
 * unscoped, all-organizations queries, and it re-checks the operator gate on
 * every call — importing it from tenant code paths will throw at runtime for
 * non-operators, so a leaked import cannot expose foreign data.
 */
export async function getPlatformDb() {
  await requirePlatformOperator();
  return rawDb;
}
