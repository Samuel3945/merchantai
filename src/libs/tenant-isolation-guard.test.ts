import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ─── Tenant-isolation drift guard ────────────────────────────────────────────
//
// The scoped `db()` in `db-context.ts` injects `WHERE organization_id = orgId`
// automatically and is the safe default. The RAW `@/libs/DB` bypasses that proxy
// entirely: a route using it becomes responsible for filtering by
// organization_id on EVERY query. A single forgotten filter = a cross-tenant
// data leak (one business reading another's data — a privacy/legal incident).
//
// This test fails the build if ANY route under src/app/api imports the raw
// `@/libs/DB` without being on the audited allowlist below. New raw-db routes
// must be security-reviewed and added here on purpose — never by accident.

const API_DIR = join(process.cwd(), 'src', 'app', 'api');
const RAW_DB_IMPORT = /from\s+['"]@\/libs\/DB['"]/;

// Every entry was security-audited on 2026-06-14 and confirmed to scope each
// tenant query by organization_id, or to be an intentional cross-org job.
// Paths are relative to src/app/api, using '/' separators.
//
// PREFER the scoped helpers from db-context.ts: `db()` (Clerk session),
// `db.forPosAuth(ctx)` (POS token), `db.forOrg(orgId)`, or the explicit
// `db.unsafeNoOrgFilter("reason")` escape hatch for cross-org work. Only add a
// file here after auditing that every query is org-scoped.
const RAW_DB_ALLOWLIST = new Set<string>([
  // Cron jobs — cross-org by design (operate on every tenant at once).
  'cron/audit-log-purge/route.ts',
  'cron/session-cleanup/route.ts',
  'cron/smart-stock-recompute/route.ts',
  // Pre-auth flows — gated by an unguessable token; org derived from the row.
  'invitations/accept/route.ts',
  'invitations/validate/route.ts',
  'pos/connect/route.ts',
  'pos/login/route.ts',
  // Clerk-auth — scope by auth() orgId.
  'expiration/alerts/route.ts',
  'expiration/suggestions/[id]/accept/route.ts',
  'expiration/suggestions/[id]/reject/route.ts',
  // POS token-auth — scope by requirePosAuth ctx.organizationId.
  'pos/cash/close/route.ts',
  'pos/cash/current/route.ts',
  'pos/cash/movement/route.ts',
  'pos/cash/open/route.ts',
  'pos/cashiers/route.ts',
  'pos/cashiers/set-pin/route.ts',
  'pos/cashiers/verify-pin/route.ts',
  'pos/customers/[id]/route.ts',
  'pos/me/route.ts',
  'pos/payment-methods/route.ts',
  'pos/sales/route.ts',
  'pos/sales/[saleId]/return/route.ts',
  'pos/sync/route.ts',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function apiRelative(file: string): string {
  return relative(API_DIR, file).split(sep).join('/');
}

function rawDbRoutes(): string[] {
  return walk(API_DIR)
    .filter(file => RAW_DB_IMPORT.test(readFileSync(file, 'utf8')))
    .map(apiRelative)
    .sort();
}

describe('tenant isolation: raw @/libs/DB usage', () => {
  it('no API route imports the raw db outside the audited allowlist', () => {
    const offenders = rawDbRoutes().filter(r => !RAW_DB_ALLOWLIST.has(r));

    expect(
      offenders,
      `These routes use the raw, un-scoped @/libs/DB and were NOT security-audited.\n`
      + `Each query MUST filter by organization_id, or a tenant could read another's data.\n`
      + `Fix: migrate to the scoped db()/db.forPosAuth()/db.forOrg() from db-context.ts.\n`
      + `If raw db is truly required, audit every query and add the file to RAW_DB_ALLOWLIST.\n`
      + `Offending routes:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('allowlist has no stale entries (every entry still uses the raw db)', () => {
    const live = new Set(rawDbRoutes());
    const stale = [...RAW_DB_ALLOWLIST].filter(r => !live.has(r)).sort();

    expect(
      stale,
      `These allowlist entries no longer import the raw @/libs/DB (migrated or moved).\n`
      + `Remove them from RAW_DB_ALLOWLIST to keep the audit surface tight:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
