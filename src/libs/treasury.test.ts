import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTreasuryAccount,
  deactivateTreasuryAccount,
  getTreasuryPosition,
  listTreasuryAccounts,
  recordConsignacion,
  seedOpeningBalance,
} from '@/libs/treasury';

// ── PGlite-backed tests for the treasury position (Phase 1 + Phase 2A) ───────

type Executor = Parameters<typeof getTreasuryPosition>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'fiado_payment', 'reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
  // 2A enum additions
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment')`,
];

const DDL = `
  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL
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
    notes text
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
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

  -- 2A stub tables (FK dependencies for treasury_accounts)
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
    expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_mov_one_external CHECK (
      num_nonnulls(from_account_id, to_account_id) = 2
      OR num_nonnulls(from_account_id, to_account_id) = 1
    )
  );
`;

const ORG = 'org-1';
const TOKEN = '00000000-0000-0000-0000-0000000000a1';
const SESSION = '00000000-0000-0000-0000-0000000000b1';

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  // FK order: children before parents.
  // 2A tables first (movements → accounts → expenses → payment_methods),
  // then the Phase-1 tables.
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM payment_methods');
  await pg.exec('DELETE FROM treasury_transfers');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
});

function byKey(accounts: Awaited<ReturnType<typeof getTreasuryPosition>>) {
  return Object.fromEntries(accounts.map(a => [a.key, a.balance]));
}

describe('getTreasuryPosition', () => {
  it('derives caja, caja fuerte and bank balances from existing data', async () => {
    await pg.query(
      `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
      [TOKEN, ORG],
    );
    await pg.query(
      `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status) VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
      [SESSION, ORG, TOKEN],
    );
    // Drawer: +100 sale, −30 security withdrawal → expected 70.
    await pg.query(
      `INSERT INTO cash_movements (session_id, organization_id, type, amount, reason, created_by) VALUES
        ($1, $2, 'sale', '100.00', 'Venta', 'cajero'),
        ($1, $2, 'withdrawal', '30.00', 'Retiro de seguridad', 'cajero')`,
      [SESSION, ORG],
    );
    // Bank: one confirmed Nequi (50 landed) and one still pending (40, not money yet).
    await pg.query(
      `INSERT INTO transfer_reconciliations (organization_id, method, expected_amount, arrived_amount, status) VALUES
        ($1, 'Nequi', '50.00', '50.00', 'confirmed'),
        ($1, 'Nequi', '40.00', NULL, 'pending')`,
      [ORG],
    );

    const accounts = await getTreasuryPosition(db, ORG);
    const balances = byKey(accounts);

    expect(balances[`caja:${TOKEN}`]).toBe(70);
    expect(balances['caja:oficina']).toBe(0);
    expect(balances.caja_fuerte).toBe(30);
    expect(balances['banco:Nequi']).toBe(50);
  });

  it('falls back to the last close count when a caja has no open session', async () => {
    await pg.query(
      `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
      [TOKEN, ORG],
    );
    await pg.query(
      `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status, closed_at, counted_amount) VALUES ($1, $2, $3, 'cajero', '0', 'closed', now(), '250.00')`,
      [SESSION, ORG, TOKEN],
    );

    const balances = byKey(await getTreasuryPosition(db, ORG));

    expect(balances[`caja:${TOKEN}`]).toBe(250);
  });

  it('a consignación lowers the safe and raises the bank', async () => {
    await pg.query(
      `INSERT INTO cash_sessions (id, organization_id, opened_by, opening_amount, status) VALUES ($1, $2, 'x', '0', 'open')`,
      [SESSION, ORG],
    );
    // 100 moved to the safe via a security withdrawal.
    await pg.query(
      `INSERT INTO cash_movements (session_id, organization_id, type, amount, reason, created_by) VALUES ($1, $2, 'withdrawal', '100.00', 'Retiro', 'x')`,
      [SESSION, ORG],
    );
    // 40 consigned from the safe to Nequi.
    await recordConsignacion(db, {
      organizationId: ORG,
      toBankMethod: 'Nequi',
      amount: 40,
      createdBy: 'owner',
    });

    const balances = byKey(await getTreasuryPosition(db, ORG));

    expect(balances.caja_fuerte).toBe(60); // 100 retirado − 40 consignado
    expect(balances['banco:Nequi']).toBe(40); // landed in the bank
  });

  it('scopes everything to the organization', async () => {
    await pg.query(
      `INSERT INTO transfer_reconciliations (organization_id, method, expected_amount, arrived_amount, status) VALUES ($1, 'Nequi', '99.00', '99.00', 'confirmed')`,
      ['other-org'],
    );

    const accounts = await getTreasuryPosition(db, ORG);

    expect(accounts.some(a => a.key === 'banco:Nequi')).toBe(false);
  });
});

// ── 2A: treasury_accounts schema + account APIs ────────────────────────────

describe('createTreasuryAccount', () => {
  // 2A-T2: insert row with correct defaults
  it('inserts a row with correct type, name, opening_balance, and active=true', async () => {
    const account = await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'caja_fuerte',
      name: 'Bóveda Principal',
      openingBalance: '500.00',
      createdBy: 'owner',
    });

    expect(account.organizationId).toBe(ORG);
    expect(account.type).toBe('caja_fuerte');
    expect(account.name).toBe('Bóveda Principal');
    expect(Number(account.openingBalance)).toBe(500);
    expect(account.active).toBe(true);
    expect(account.id).toBeDefined();
  });

  // 2A-T6: duplicate vault name is rejected
  it('rejects a duplicate name within the same org', async () => {
    await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'caja_fuerte',
      name: 'Bóveda Principal',
      openingBalance: '0',
      createdBy: 'owner',
    });

    await expect(
      createTreasuryAccount(db, {
        organizationId: ORG,
        type: 'caja_fuerte',
        name: 'Bóveda Principal',
        openingBalance: '0',
        createdBy: 'owner',
      }),
    ).rejects.toThrow(/duplicate|unique|ya existe/i);
  });

  it('allows the same name in a different org', async () => {
    await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'caja_fuerte',
      name: 'Bóveda',
      openingBalance: '0',
      createdBy: 'owner',
    });

    // Should not throw
    await expect(
      createTreasuryAccount(db, {
        organizationId: 'other-org',
        type: 'caja_fuerte',
        name: 'Bóveda',
        openingBalance: '0',
        createdBy: 'owner',
      }),
    ).resolves.toBeDefined();
  });
});

describe('listTreasuryAccounts', () => {
  // 2A-T3: returns only active accounts for the org
  it('returns only active accounts for the org, excludes other orgs and inactive rows', async () => {
    await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'caja_fuerte',
      name: 'Activa',
      openingBalance: '100',
      createdBy: 'owner',
    });
    const inactive = await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'banco',
      name: 'Inactiva',
      openingBalance: '0',
      createdBy: 'owner',
    });
    await deactivateTreasuryAccount(db, inactive.id, ORG);

    await createTreasuryAccount(db, {
      organizationId: 'other-org',
      type: 'caja_fuerte',
      name: 'Ajena',
      openingBalance: '0',
      createdBy: 'owner',
    });

    const accounts = await listTreasuryAccounts(db, ORG);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('Activa');
    expect(accounts.every(a => a.organizationId === ORG)).toBe(true);
    expect(accounts.every(a => a.active)).toBe(true);
  });
});

describe('deactivateTreasuryAccount', () => {
  // 2A-T4: sets active=false; row still queryable
  it('sets active=false and the row remains in the database', async () => {
    const acc = await createTreasuryAccount(db, {
      organizationId: ORG,
      type: 'caja_fuerte',
      name: 'Vault',
      openingBalance: '0',
      createdBy: 'owner',
    });

    await deactivateTreasuryAccount(db, acc.id, ORG);

    // listTreasuryAccounts only returns active → should be empty

    const active = await listTreasuryAccounts(db, ORG);

    expect(active).toHaveLength(0);

    // But a raw query should still find the row
    const row = await pg.query<{ active: boolean }>(
      'SELECT active FROM treasury_accounts WHERE id = $1',

      [acc.id],
    );

    expect(row.rows[0]?.active).toBe(false);
  });
});

describe('seedOpeningBalance', () => {
  // 2A-T5: seed derivation matches getTreasuryPosition snapshot for caja_fuerte
  it('returns the same caja_fuerte balance as the Phase-1 getTreasuryPosition derivation', async () => {
    await pg.query(
      `INSERT INTO cash_sessions (id, organization_id, opened_by, opening_amount, status) VALUES ($1, $2, 'x', '0', 'open')`,
      [SESSION, ORG],
    );
    await pg.query(
      `INSERT INTO cash_movements (session_id, organization_id, type, amount, reason, created_by) VALUES ($1, $2, 'withdrawal', '200.00', 'Retiro', 'x')`,
      [SESSION, ORG],
    );
    // 50 consigned out via treasury_transfers
    await pg.query(
      `INSERT INTO treasury_transfers (organization_id, from_account, to_account, amount, created_by) VALUES ($1, 'caja_fuerte', 'banco:Nequi', '50.00', 'x')`,
      [ORG],
    );

    const position = await getTreasuryPosition(db, ORG);
    const phase1Balance = position.find(a => a.key === 'caja_fuerte')?.balance ?? -1;

    const seeded = await seedOpeningBalance(db, ORG, 'caja_fuerte');

    expect(seeded).toBe(phase1Balance);
    expect(seeded).toBe(150); // 200 withdrawn − 50 consigned
  });
});
