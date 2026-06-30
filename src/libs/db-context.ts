import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { PosAuthContext } from '@/libs/pos-auth';
import { auth } from '@clerk/nextjs/server';
import { and, eq, getTableName } from 'drizzle-orm';
import { db as rawDb } from '@/libs/DB';

// ─── getCurrentOrgId ─────────────────────────────────────────────────────
// Resolves the active organization from Clerk. Throws on missing org so the
// caller doesn't silently fall back to "all orgs" — a tenant-isolation breach.

export async function getCurrentOrgId(): Promise<string> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No org');
  }
  return orgId;
}

// ─── Table classification ───────────────────────────────────────────────
// Tables carrying organizationId directly: the proxy auto-scopes them.
// Child tables (sale_items, etc.) inherit their org via the parent FK; the
// proxy refuses to touch them directly so callers either JOIN through the
// parent or escape via `db.unsafeNoOrgFilter("...")`.

const TENANT_TABLES: ReadonlySet<string> = new Set([
  'products',
  'sales',
  'cash_sessions',
  'cash_movements',
  'pos_users',
  'pos_tokens',
  'employee_invitations',
  'organization_plans',
  'plan_addons',
  'subscriptions',
  'usage_counters',
  'top_ups',
  'customers',
  'pos_returns',
  'stock_movements',
  'expiration_risk_cache',
  'expiration_suggestions',
  'payment_methods',
  'notifications',
  'audit_logs',
  'app_settings',
  'suppliers',
  'cash_security_threshold_cache',
  'supplier_purchases',
  'supplier_payables',
  'supplier_payments',
  'supplier_payable_credits',
  'supplier_refunds',
  // Treasury containers and ledger (accessed via helpers; proxy adds org filter).
  'treasury_accounts',
  'treasury_movements',
  // AI agent backbone: token issuance, conversations, messages, and the channel
  // table itself (capability lookup now uses db.forOrg inside agent-auth).
  'agent_tokens',
  'conversations',
  'messages',
  'whatsapp_channels',
]);

const CHILD_TABLES: ReadonlySet<string> = new Set([
  'sale_items',
  'sale_payments',
  'pos_sessions',
  'pos_return_items',
  'todo',
]);

function getOrgColumn(table: PgTable): unknown {
  const col = (table as unknown as Record<string, unknown>).organizationId;
  if (!col) {
    throw new Error(
      `Table '${getTableName(table)}' has no organizationId column. `
      + 'Use db.unsafeNoOrgFilter("...") or query via the parent.',
    );
  }
  return col;
}

function assertTenantTable(table: PgTable): void {
  const name = getTableName(table);
  if (CHILD_TABLES.has(name)) {
    throw new Error(
      `Cannot directly query child table '${name}' through tenant db(). `
      + 'JOIN it from the parent tenant table, or use db.unsafeNoOrgFilter("...").',
    );
  }
  if (!TENANT_TABLES.has(name)) {
    throw new Error(
      `Table '${name}' is not registered as a tenant table. `
      + 'Add it to TENANT_TABLES in db-context.ts or use db.unsafeNoOrgFilter("...").',
    );
  }
}

// ─── createTenantDb ─────────────────────────────────────────────────────
// Builds the scoped wrapper around a raw drizzle instance (or a tx handle).
// Each terminal builder (select/update/delete) carries its own "rebuild"
// closure so a caller-supplied `.where(...)` re-ANDs the org filter instead
// of overriding it — drizzle's PgSelectBase.where is single-shot, so we
// can't append; we rebuild from a known-safe base every time.

type RawDb = typeof rawDb;
type TxLike = Parameters<Parameters<RawDb['transaction']>[0]>[0];

const SELECT_CHAIN = new Set([
  'orderBy',
  'limit',
  'offset',
  'groupBy',
  'having',
  'for',
  'leftJoin',
  'rightJoin',
  'innerJoin',
  'fullJoin',
  'crossJoin',
  '$dynamic',
]);

const UPDATE_CHAIN = new Set(['returning']);
const DELETE_CHAIN = new Set(['returning']);

type Op = { m: string; a: unknown[] };

function rebuildSelect(
  base: RawDb | TxLike,
  table: PgTable,
  orgFilter: SQL,
  fields: unknown,
  extraWhere: SQL | undefined,
  ops: Op[],
) {
  const builder = fields
    ? (base as RawDb).select(fields as never)
    : (base as RawDb).select();
  let q: unknown = builder.from(table as never);
  q = (q as { where: (c: SQL) => unknown }).where(
    extraWhere ? (and(orgFilter, extraWhere) as SQL) : orgFilter,
  );
  for (const op of ops) {
    q = (q as Record<string, (...args: unknown[]) => unknown>)[op.m]!(...op.a);
  }
  return q;
}

function wrapSelect(
  base: RawDb | TxLike,
  table: PgTable,
  orgFilter: SQL,
  fields: unknown,
): unknown {
  function wrap(extraWhere: SQL | undefined, ops: Op[]): unknown {
    const q = rebuildSelect(base, table, orgFilter, fields, extraWhere, ops);
    return new Proxy(q as object, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === 'where') {
          return (cond: SQL) => wrap(cond, ops);
        }
        if (SELECT_CHAIN.has(prop)) {
          return (...args: unknown[]) =>
            wrap(extraWhere, [...ops, { m: prop, a: args }]);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (value as (...a: unknown[]) => unknown).bind(target);
        }
        return value;
      },
    });
  }
  return wrap(undefined, []);
}

function rebuildUpdate(
  base: RawDb | TxLike,
  table: PgTable,
  orgFilter: SQL,
  values: Record<string, unknown>,
  extraWhere: SQL | undefined,
  ops: Op[],
) {
  let q: unknown = (base as RawDb).update(table as never).set(values as never);
  q = (q as { where: (c: SQL) => unknown }).where(
    extraWhere ? (and(orgFilter, extraWhere) as SQL) : orgFilter,
  );
  for (const op of ops) {
    q = (q as Record<string, (...args: unknown[]) => unknown>)[op.m]!(...op.a);
  }
  return q;
}

function wrapUpdate(
  base: RawDb | TxLike,
  table: PgTable,
  orgFilter: SQL,
  values: Record<string, unknown>,
): unknown {
  function wrap(extraWhere: SQL | undefined, ops: Op[]): unknown {
    const q = rebuildUpdate(base, table, orgFilter, values, extraWhere, ops);
    return new Proxy(q as object, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === 'where') {
          return (cond: SQL) => wrap(cond, ops);
        }
        if (UPDATE_CHAIN.has(prop)) {
          return (...args: unknown[]) =>
            wrap(extraWhere, [...ops, { m: prop, a: args }]);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (value as (...a: unknown[]) => unknown).bind(target);
        }
        return value;
      },
    });
  }
  return wrap(undefined, []);
}

function rebuildDelete(
  base: RawDb | TxLike,
  table: PgTable,
  orgFilter: SQL,
  extraWhere: SQL | undefined,
  ops: Op[],
) {
  let q: unknown = (base as RawDb).delete(table as never);
  q = (q as { where: (c: SQL) => unknown }).where(
    extraWhere ? (and(orgFilter, extraWhere) as SQL) : orgFilter,
  );
  for (const op of ops) {
    q = (q as Record<string, (...args: unknown[]) => unknown>)[op.m]!(...op.a);
  }
  return q;
}

function wrapDelete(base: RawDb | TxLike, table: PgTable, orgFilter: SQL): unknown {
  function wrap(extraWhere: SQL | undefined, ops: Op[]): unknown {
    const q = rebuildDelete(base, table, orgFilter, extraWhere, ops);
    return new Proxy(q as object, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === 'where') {
          return (cond: SQL) => wrap(cond, ops);
        }
        if (DELETE_CHAIN.has(prop)) {
          return (...args: unknown[]) =>
            wrap(extraWhere, [...ops, { m: prop, a: args }]);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (value as (...a: unknown[]) => unknown).bind(target);
        }
        return value;
      },
    });
  }
  return wrap(undefined, []);
}

// The proxy delegates to the real drizzle builder, so we re-expose drizzle's
// own builder signatures. `insert` is the one exception — we drop the
// requirement to pass `organizationId` since the proxy injects it. Callers
// still get full inference (select fields, returning(), update sets, etc.)
// — exactly as if they were calling the raw db, only with org filters
// silently woven in at runtime.

type RawInsertValuesReturn = ReturnType<
  ReturnType<RawDb['insert']>['values']
>;

type TenantInsertValues<T extends PgTable>
  = T extends { $inferInsert: infer V }
    ? V extends Record<string, unknown>
      ? (Omit<V, 'organizationId'> & { organizationId?: string }) | (Omit<V, 'organizationId'> & { organizationId?: string })[]
      : never
    : never;

type TenantInsert = <T extends PgTable>(
  table: T,
) => {
  values: (value: TenantInsertValues<T>) => RawInsertValuesReturn;
};

export type TenantDb = {
  readonly orgId: string;
  readonly select: RawDb['select'];
  readonly insert: TenantInsert;
  readonly update: RawDb['update'];
  readonly delete: RawDb['delete'];
  transaction: <T>(cb: (tx: TenantDb) => Promise<T>) => Promise<T>;
  execute: () => never;
};

export function createTenantDb(base: RawDb | TxLike, orgId: string): TenantDb {
  const selectFn = ((fields?: unknown) => {
    return {
      from(table: PgTable) {
        assertTenantTable(table);
        const orgFilter = eq(getOrgColumn(table) as never, orgId) as SQL;
        return wrapSelect(base, table, orgFilter, fields);
      },
    };
  }) as unknown as RawDb['select'];

  const insertFn = ((table: PgTable) => {
    assertTenantTable(table);
    const builder = (base as RawDb).insert(table as never);
    return {
      values(values: Record<string, unknown> | Record<string, unknown>[]) {
        const force = (v: Record<string, unknown>) => ({
          ...v,
          organizationId: orgId,
        });
        const merged = Array.isArray(values) ? values.map(force) : force(values);
        return builder.values(merged as never);
      },
    };
  }) as unknown as TenantInsert;

  const updateFn = ((table: PgTable) => {
    assertTenantTable(table);
    const orgFilter = eq(getOrgColumn(table) as never, orgId) as SQL;
    return {
      set(values: Record<string, unknown>) {
        const { organizationId: _drop, ...safeValues } = values;
        return wrapUpdate(base, table, orgFilter, safeValues);
      },
    };
  }) as unknown as RawDb['update'];

  const deleteFn = ((table: PgTable) => {
    assertTenantTable(table);
    const orgFilter = eq(getOrgColumn(table) as never, orgId) as SQL;
    return wrapDelete(base, table, orgFilter);
  }) as unknown as RawDb['delete'];

  async function transactionFn<T>(cb: (tx: TenantDb) => Promise<T>): Promise<T> {
    return (base as RawDb).transaction(async tx =>
      cb(createTenantDb(tx, orgId)),
    );
  }

  function executeBlock(): never {
    throw new Error(
      'db().execute() is disabled — raw SQL bypasses tenant scoping. '
      + 'Use db.unsafeNoOrgFilter("...justification...") and embed organization_id in the SQL, '
      + 'or rewrite using the typed query builder.',
    );
  }

  return {
    orgId,
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    transaction: transactionFn,
    execute: executeBlock,
    // `query` (relational API) is intentionally omitted; callers that need it
    // can opt out via `db.unsafeNoOrgFilter()` and filter manually.
  };
}

// ─── Public surface ─────────────────────────────────────────────────────
// `db()` is async because it resolves the orgId from Clerk. The companion
// helpers stay synchronous so callers with an explicit org (POS endpoints,
// tests) don't pay for an extra microtask.

type DbFn = {
  (): Promise<TenantDb>;
  unsafeNoOrgFilter: (justification: string) => RawDb;
  forPosAuth: (ctx: PosAuthContext) => TenantDb;
  forOrg: (orgId: string, base?: RawDb) => TenantDb;
};

export const db: DbFn = Object.assign(
  async () => {
    const orgId = await getCurrentOrgId();
    return createTenantDb(rawDb, orgId);
  },
  {
    // Escape hatch for cron jobs, webhooks, and admin tools. The justification
    // is parsed at runtime and logged; it must read like a comment, not a
    // copy-pasted placeholder.
    unsafeNoOrgFilter(justification: string): RawDb {
      const trimmed = (justification ?? '').trim();
      if (trimmed.length < 20) {
        throw new Error(
          'unsafeNoOrgFilter requires a >= 20 char justification comment '
          + '(e.g. "cron job: recompute expiration risk cache for all orgs").',
        );
      }
      return rawDb;
    },
    forPosAuth(ctx: PosAuthContext): TenantDb {
      if (!ctx?.organizationId) {
        throw new Error('forPosAuth received PosAuthContext without organizationId');
      }
      return createTenantDb(rawDb, ctx.organizationId);
    },
    forOrg(orgId: string, base: RawDb = rawDb): TenantDb {
      if (!orgId) {
        throw new Error('forOrg requires an explicit orgId');
      }
      return createTenantDb(base, orgId);
    },
  },
) as DbFn;
