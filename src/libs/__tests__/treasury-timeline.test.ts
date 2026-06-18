import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listTreasuryTimeline } from '@/libs/treasury';

// ── PGlite-backed integration test for listTreasuryTimeline ─────────────────
// The function reads treasury_movements ordered by created_at DESC and returns
// display-ready entries with fromAccount and toAccount names resolved.

type Executor = Parameters<typeof listTreasuryTimeline>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'fiado_payment', 'reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover')`,
];

const DDL = `
  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    default_sweep_destination_account_id uuid
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

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
    resolution_fiado_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;

  CREATE TABLE treasury_transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account text NOT NULL,
    to_account text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    note text,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL
  );

  CREATE TABLE expenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    amount numeric(12,2) NOT NULL,
    category text NOT NULL,
    description text,
    incurred_on date NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid REFERENCES payment_methods(id) ON DELETE RESTRICT,
    pos_token_id uuid REFERENCES pos_tokens(id) ON DELETE SET NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_accounts_org_name_unique UNIQUE (organization_id, name)
  );

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account_id uuid REFERENCES treasury_accounts(id) ON DELETE RESTRICT,
    to_account_id uuid REFERENCES treasury_accounts(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    type "treasury_movement_type" NOT NULL,
    category text,
    reason text,
    expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    handover_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_mov_one_external CHECK (
      num_nonnulls(from_account_id, to_account_id) = 2
      OR (
        num_nonnulls(from_account_id, to_account_id) = 1
        AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
      )
    )
  );
`;

const ORG = 'org-timeline';

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM payment_methods');
  await pg.exec('DELETE FROM treasury_transfers');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
});

async function makeAccount(name: string, type: 'caja_fuerte' | 'banco'): Promise<string> {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, '0', true, now(), now())
     RETURNING id`,
    [ORG, type, name],
  );
  return res.rows[0]!.id;
}

describe('listTreasuryTimeline', () => {
  it('returns an empty array when there are no treasury movements', async () => {
    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows).toHaveLength(0);
  });

  it('returns movements ordered by created_at DESC (newest first)', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');
    const bancoId = await makeAccount('Nequi', 'banco');

    // Insert older movement first, newer second.
    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '100.00', 'transfer', 'owner', '2026-06-10 10:00:00')`,
      [ORG, vaultId, bancoId],
    );
    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '200.00', 'consignacion', 'owner', '2026-06-15 12:00:00')`,
      [ORG, vaultId, bancoId],
    );

    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows).toHaveLength(2);
    // Newest first
    expect(rows[0]!.amount).toBe(200);
    expect(rows[0]!.type).toBe('consignacion');
    expect(rows[1]!.amount).toBe(100);
    expect(rows[1]!.type).toBe('transfer');
  });

  it('resolves fromAccount and toAccount names from treasury_accounts', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');
    const bancoId = await makeAccount('Nequi', 'banco');

    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, '500.00', 'transfer', 'owner')`,
      [ORG, vaultId, bancoId],
    );

    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromAccount).toBe('Caja fuerte');
    expect(rows[0]!.toAccount).toBe('Nequi');
  });

  it('resolves gasto movements with null toAccount (external destination)', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');

    const expRes = await pg.query<{ id: string }>(
      `INSERT INTO expenses (organization_id, amount, category, incurred_on, created_by)
       VALUES ($1, '75.00', 'servicios', '2026-06-15', 'owner')
       RETURNING id`,
      [ORG],
    );
    const expId = expRes.rows[0]!.id;

    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, expense_id, created_by)
       VALUES (gen_random_uuid(), $1, $2, NULL, '75.00', 'gasto', $3, 'owner')`,
      [ORG, vaultId, expId],
    );

    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromAccount).toBe('Caja fuerte');
    expect(rows[0]!.toAccount).toBeNull();
    expect(rows[0]!.type).toBe('gasto');
  });

  it('scopes results to the organization — other org movements are excluded', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');
    const bancoId = await makeAccount('Nequi', 'banco');

    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by)
       VALUES (gen_random_uuid(), 'other-org', $1, $2, '999.00', 'transfer', 'owner')`,
      [vaultId, bancoId],
    );

    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows).toHaveLength(0);
  });

  it('respects the optional limit parameter', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');
    const bancoId = await makeAccount('Nequi', 'banco');

    // Insert 3 movements.
    for (let i = 0; i < 3; i++) {
      await pg.query(
        `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, '${(i + 1) * 10}.00', 'transfer', 'owner')`,
        [ORG, vaultId, bancoId],
      );
    }

    const rows = await listTreasuryTimeline(db, ORG, 2);

    expect(rows).toHaveLength(2);
  });

  it('returns id and createdAt on each entry', async () => {
    const vaultId = await makeAccount('Caja fuerte', 'caja_fuerte');
    const bancoId = await makeAccount('Nequi', 'banco');

    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, to_account_id, amount, type, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, '1000.00', 'consignacion', 'owner')`,
      [ORG, vaultId, bancoId],
    );

    const rows = await listTreasuryTimeline(db, ORG);

    expect(rows[0]!.id).toBeDefined();
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });
});
