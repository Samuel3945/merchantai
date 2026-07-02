/**
 * Cuadre-per-account redesign — pending-by-account grouping (lib layer).
 *
 * Scenarios covered:
 *   - Sums PENDING expectedAmount grouped by the banco account each method
 *     resolves to (mirrors resolveBancoForMethod's exact join).
 *   - Zero-match methods (no payment_methods/treasury_accounts row) land in
 *     the `unresolved` bucket instead of being dropped.
 *   - Multi-match methods (two active bancos linked to the same method name)
 *     also land in `unresolved` — the "exactly one" rule.
 *   - Non-pending statuses are excluded from the aggregation entirely.
 *   - getPendingReconciliationIdsForAccount resolves only the ids that
 *     unambiguously belong to the given account.
 *
 * All tests run against the PGLite in-memory engine to avoid I/O.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getPendingReconciliationIdsForAccount,
  getPendingReconciliationsByAccount,
} from '@/libs/transfer-reconciliation';
import { transferReconciliationsSchema } from '@/models/Schema';

// ── PGlite-backed integration tests ──────────────────────────────────────────

type Executor = Parameters<typeof getPendingReconciliationsByAccount>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja', 'caja_fuerte', 'banco', 'transito')`,
];

const DDL = `
  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
    pos_token_id uuid,
    cash_session_id uuid,
    method text NOT NULL,
    expected_amount numeric(12, 2) NOT NULL,
    arrived_amount numeric(12, 2),
    reference text,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    reconciled_by text,
    reconciled_at timestamp,
    note text,
    resolution_type "transfer_resolution_type",
    resolved_by text,
    resolved_at timestamp,
    resolution_credito_id uuid,
    claim_open boolean DEFAULT false NOT NULL,
    recovery_of_id uuid,
    remainder_reconciliation_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;

  -- Stub tables for resolveBancoForMethod's join (mirrors treasury.test.ts).
  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid REFERENCES payment_methods(id) ON DELETE RESTRICT,
    pos_token_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-cuadre';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seed(overrides: Record<string, unknown> = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db.insert(transferReconciliationsSchema).values({
    id,
    organizationId: ORG,
    method: 'Nequi',
    expectedAmount: '100.00',
    status: 'pending',
    ...overrides,
  } as any);
  return id;
}

async function seedBanco(args: {
  methodId: string;
  bancoId: string;
  methodName: string;
  bancoName: string;
  methodType?: string;
  active?: boolean;
}) {
  await pg.query(
    `INSERT INTO payment_methods (id, organization_id, name, type) VALUES ($1, $2, $3, $4)`,
    [args.methodId, ORG, args.methodName, args.methodType ?? 'transfer'],
  );
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, payment_method_id, active)
     VALUES ($1, $2, 'banco', $3, $4, $5)`,
    [args.bancoId, ORG, args.bancoName, args.methodId, args.active ?? true],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;

  for (const e of ENUMS) {
    await pg.exec(e);
  }

  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM payment_methods');
  counter = 0;
});

describe('getPendingReconciliationsByAccount', () => {
  it('sums pending expectedAmount grouped by the resolved banco account', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });

    await seed({ method: 'Nequi', expectedAmount: '100.00' });
    await seed({ method: 'Nequi', expectedAmount: '50.00' });

    const result = await getPendingReconciliationsByAccount(db, ORG);

    expect(result.byAccount).toEqual([
      { accountId: NEQUI_BANCO, total: 150, count: 2, methods: ['Nequi'] },
    ]);
    expect(result.unresolved).toEqual({ total: 0, count: 0, methods: [] });
  });

  it('excludes non-pending rows from the aggregation', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });

    await seed({ method: 'Nequi', expectedAmount: '100.00', status: 'pending' });
    await seed({ method: 'Nequi', expectedAmount: '999.00', status: 'confirmed', arrivedAmount: '999.00' });

    const result = await getPendingReconciliationsByAccount(db, ORG);

    expect(result.byAccount).toEqual([
      { accountId: NEQUI_BANCO, total: 100, count: 1, methods: ['Nequi'] },
    ]);
  });

  it('puts a ZERO-match method (no payment_methods/treasury_accounts row) in the unresolved bucket', async () => {
    await seed({ method: 'Daviplata', expectedAmount: '75.00' });

    const result = await getPendingReconciliationsByAccount(db, ORG);

    expect(result.byAccount).toEqual([]);
    expect(result.unresolved).toEqual({
      total: 75,
      count: 1,
      methods: [{ method: 'Daviplata', total: 75, count: 1 }],
    });
  });

  it('puts a MULTI-match method (2+ active bancos linked to the same method name) in the unresolved bucket', async () => {
    // Two DIFFERENT payment_methods rows sharing the SAME name "Nequi" — both
    // active bancos, both type='transfer' — the same ambiguity
    // resolveBancoForMethod itself refuses to resolve.
    await seedBanco({
      methodId: UUID(201),
      bancoId: UUID(202),
      methodName: 'Nequi',
      bancoName: 'Banco Nequi Principal',
    });
    await seedBanco({
      methodId: UUID(203),
      bancoId: UUID(204),
      methodName: 'Nequi',
      bancoName: 'Banco Nequi Secundario',
    });

    await seed({ method: 'Nequi', expectedAmount: '40.00' });

    const result = await getPendingReconciliationsByAccount(db, ORG);

    expect(result.byAccount).toEqual([]);
    expect(result.unresolved).toEqual({
      total: 40,
      count: 1,
      methods: [{ method: 'Nequi', total: 40, count: 1 }],
    });
  });

  it('keeps resolved and unresolved methods independent side by side', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });

    await seed({ method: 'Nequi', expectedAmount: '200.00' });
    await seed({ method: 'Daviplata', expectedAmount: '30.00' });

    const result = await getPendingReconciliationsByAccount(db, ORG);

    expect(result.byAccount).toEqual([
      { accountId: NEQUI_BANCO, total: 200, count: 1, methods: ['Nequi'] },
    ]);
    expect(result.unresolved).toEqual({
      total: 30,
      count: 1,
      methods: [{ method: 'Daviplata', total: 30, count: 1 }],
    });
  });

  it('never resolves a bank from another org (tenant isolation)', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });

    await seed({ method: 'Nequi', expectedAmount: '100.00' });

    const result = await getPendingReconciliationsByAccount(db, 'org-other');

    expect(result.byAccount).toEqual([]);
    expect(result.unresolved).toEqual({ total: 0, count: 0, methods: [] });
  });
});

describe('getPendingReconciliationIdsForAccount', () => {
  it('resolves only the pending ids whose method maps to the given account', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    const DAVI_METHOD = UUID(103);
    const DAVI_BANCO = UUID(104);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });
    await seedBanco({
      methodId: DAVI_METHOD,
      bancoId: DAVI_BANCO,
      methodName: 'Daviplata',
      bancoName: 'Banco Daviplata',
    });

    const nequi1 = await seed({ method: 'Nequi' });
    const nequi2 = await seed({ method: 'Nequi' });
    const davi1 = await seed({ method: 'Daviplata' });

    const ids = await getPendingReconciliationIdsForAccount(db, {
      organizationId: ORG,
      accountId: NEQUI_BANCO,
    });

    expect(ids.sort()).toEqual([nequi1, nequi2].sort());
    expect(ids).not.toContain(davi1);
  });

  it('excludes an ambiguous (multi-match) method even for one of the colliding accounts', async () => {
    const bancoA = UUID(202);
    const bancoB = UUID(204);
    await seedBanco({
      methodId: UUID(201),
      bancoId: bancoA,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi A',
    });
    await seedBanco({
      methodId: UUID(203),
      bancoId: bancoB,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi B',
    });

    await seed({ method: 'Nequi' });

    const ids = await getPendingReconciliationIdsForAccount(db, {
      organizationId: ORG,
      accountId: bancoA,
    });

    expect(ids).toEqual([]);
  });

  it('returns an empty array when the account has no pending rows', async () => {
    const NEQUI_METHOD = UUID(101);
    const NEQUI_BANCO = UUID(102);
    await seedBanco({
      methodId: NEQUI_METHOD,
      bancoId: NEQUI_BANCO,
      methodName: 'Nequi',
      bancoName: 'Banco Nequi',
    });

    const ids = await getPendingReconciliationIdsForAccount(db, {
      organizationId: ORG,
      accountId: NEQUI_BANCO,
    });

    expect(ids).toEqual([]);
  });
});
