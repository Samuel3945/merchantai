# db-context migration audit

The tenant-scoped wrapper lives in `src/libs/db-context.ts`. Server-side code
should reach the database through it rather than importing `db` from
`@/libs/DB` directly. This file tracks which call sites are still on the
legacy import.

## Migrated (reference patterns)

- `src/actions/inventory.ts` — Clerk-auth server actions: `const tdb = await db();` then build queries on `tdb`.
- `src/app/api/pos/customers/route.ts` — POS endpoint: `const tdb = db.forPosAuth(ctx);` after `resolvePosAuth(...)`.

## Pending — Clerk-auth server actions

These all `import { db } from '@/libs/DB'` and must be ported to `import { db } from '@/libs/db-context'`:

- [ ] `src/actions/app-settings.ts`
- [ ] `src/actions/audit-log.ts`
- [ ] `src/actions/cash.ts`
- [ ] `src/actions/dashboard.ts`
- [ ] `src/actions/employees.ts`
- [ ] `src/actions/creditos.ts`
- [ ] `src/actions/notifications.ts`
- [ ] `src/actions/payment-methods.ts`
- [ ] `src/actions/plans.ts`
- [ ] `src/actions/pos-tokens.ts`
- [ ] `src/actions/reports.ts`
- [ ] `src/actions/sales.ts`

Migration recipe per file:

1. Replace `import { db } from '@/libs/DB'` → `import { db } from '@/libs/db-context'`.
2. Replace `requireOrgId()` (or the equivalent inline `auth()` + `eq(table.organizationId, orgId)` filter) with `const tdb = await db();`. Keep an `await auth()` only if you need `userId` for an audit field.
3. Drop manual `eq(table.organizationId, orgId)` clauses — the proxy injects them.
4. Drop `organizationId: orgId` from `.values()` payloads — the proxy injects it on insert.
5. Inside `tdb.transaction(async tx => { ... })`, `tx` is also tenant-scoped; same rules apply.

## Pending — POS endpoints (auth via posToken / posSession)

- [ ] `src/app/api/pos/cash/close/route.ts`
- [ ] `src/app/api/pos/cash/current/route.ts`
- [ ] `src/app/api/pos/cash/movement/route.ts`
- [ ] `src/app/api/pos/cash/open/route.ts`
- [ ] `src/app/api/pos/connect/route.ts`
- [ ] `src/app/api/pos/customers/[id]/route.ts`
- [ ] `src/app/api/pos/creditos/abonar/route.ts`
- [ ] `src/app/api/pos/creditos/route.ts`
- [ ] `src/app/api/pos/creditos/settle/route.ts`
- [ ] `src/app/api/pos/login/route.ts`
- [ ] `src/app/api/pos/me/route.ts`
- [ ] `src/app/api/pos/sales/[saleId]/return/route.ts`
- [ ] `src/app/api/pos/sales/route.ts`
- [ ] `src/app/api/pos/sync/route.ts`

Migration recipe per file:

1. Resolve auth as today: `const ctx = await resolvePosAuth(req.headers.get('authorization'));` and 401 if null.
2. `const tdb = db.forPosAuth(ctx);` — sync, no await.
3. Replace raw `db.execute(sql\`... WHERE organization_id = \${ctx.organizationId} ...\`)` with the typed builder on `tdb`. `tdb.execute()` is disabled by design; if the SQL is genuinely irreducible, use `db.unsafeNoOrgFilter("...justification...")` and keep the `organization_id` literal in the SQL.

`/api/pos/login/route.ts` is special: it runs before the caller has any session, so it cannot have an org context yet. Use `db.unsafeNoOrgFilter("login flow: org is unknown until credentials are verified")` to look up the `pos_users` row, then proceed.

## Pending — non-POS endpoints

- [ ] `src/app/api/ai/customer-service/route.ts` — Clerk auth; use `await db()`.
- [ ] `src/app/api/expiration/alerts/route.ts` — Clerk auth; use `await db()`.
- [ ] `src/app/api/expiration/suggestions/[id]/accept/route.ts` — Clerk auth.
- [ ] `src/app/api/expiration/suggestions/[id]/reject/route.ts` — Clerk auth.
- [ ] `src/app/api/invitations/accept/route.ts` — pre-auth flow; use `db.unsafeNoOrgFilter("invitation accept: org derived from token, not session")`.
- [ ] `src/app/api/invitations/validate/route.ts` — same as above.
- [ ] `src/app/api/cron/session-cleanup/route.ts` — cron; `db.unsafeNoOrgFilter("cron: cleans expired pos_sessions across all orgs")`.
- [ ] `src/app/api/cron/smart-stock-recompute/route.ts` — cron; same pattern.
- [ ] `src/app/api/cron/audit-log-purge/route.ts` — cron; same pattern.

## Schema registry

`TENANT_TABLES` and `CHILD_TABLES` in `db-context.ts` must be kept in sync with `src/models/Schema.ts`. If you add a new table:

- Has `organization_id text NOT NULL` → add to `TENANT_TABLES`.
- Inherits org from a parent FK → add to `CHILD_TABLES`. Direct access via `tdb` will throw; query via a JOIN from the parent.
- Otherwise (truly global) → leave it out of both sets; access goes through `db.unsafeNoOrgFilter(...)`.

## Tests

`src/libs/db-context.test.ts` covers the proxy itself (SELECT/INSERT/UPDATE/DELETE injection, child-table refusal, unsafe-hatch validation, cross-org leak scenarios). Future per-action tests should re-use `db.forOrg(orgId, mockRawDb)` to assert that a given action under org A never produces SQL referencing org B's data.
