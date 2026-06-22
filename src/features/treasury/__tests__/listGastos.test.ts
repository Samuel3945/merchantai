/**
 * REQ-6: listGastos — reads expenses table org-scoped,
 * supports date-range + category filters, resolves origin labels,
 * and computes a running total.
 *
 * Strict TDD — RED phase: all tests fail until listGastos is implemented.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listGastos } from '@/libs/gastos';

// ── Minimal PGLite DDL ───────────────────────────────────────────────────────

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
    allow_oversell boolean DEFAULT false NOT NULL,
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
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid,
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

  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE expenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    amount numeric(12,2) NOT NULL,
    category text NOT NULL,
    description text,
    incurred_on date NOT NULL,
    created_by text,
    reverses_expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT expenses_reverses_expense_id_unique UNIQUE (reverses_expense_id)
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
    transfer_reconciliation_id uuid REFERENCES transfer_reconciliations(id) ON DELETE RESTRICT,
    handover_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

// Fixed UUIDs for reproducibility
const ORG = 'org-list-gastos';
const OTHER_ORG = 'org-other';
const EXP_TREASURY = '00000000-0000-0000-0001-000000000001';
const EXP_POS = '00000000-0000-0000-0001-000000000002';
const EXP_LEGACY = '00000000-0000-0000-0001-000000000003';
const EXP_OTHER_ORG = '00000000-0000-0000-0001-000000000004';
const ACC_VAULT = '00000000-0000-0000-0002-000000000001';
const SESSION_ID = '00000000-0000-0000-0003-000000000001';
const TOKEN_ID = '00000000-0000-0000-0004-000000000001';

// Map from expense UUID → movement UUID (last 12 hex chars differ so they stay valid UUIDs)
const TREAS_MOV_MAP: Record<string, string> = {
  [EXP_TREASURY]: '00000000-0000-0000-0005-000000000001',
};
const CASH_MOV_MAP: Record<string, string> = {
  [EXP_POS]: '00000000-0000-0000-0006-000000000001',
};

type Executor = Parameters<typeof listGastos>[0];
let pg: PGlite;
let db: Executor;

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
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM payment_methods');
});

async function seedBaseData() {
  // Seed a pos token + session so cash_movements FK is satisfied
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN_ID, ORG],
  );
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
    [SESSION_ID, ORG, TOKEN_ID],
  );
  // Seed treasury vault account
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name) VALUES ($1, $2, 'caja_fuerte', 'Bóveda')`,
    [ACC_VAULT, ORG],
  );
}

async function seedTreasuryGasto(id: string, amount: string, category: string, incurredOn: string, org = ORG) {
  await pg.query(
    `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, $3, $4, $5, 'owner')`,
    [id, org, amount, category, incurredOn],
  );
  const movId = TREAS_MOV_MAP[id];
  if (movId && org === ORG) {
    await pg.query(
      `INSERT INTO treasury_movements (id, organization_id, from_account_id, amount, type, expense_id, created_by)
       VALUES ($1, $2, $3, $4, 'gasto', $5, 'owner')`,
      [movId, org, ACC_VAULT, amount, id],
    );
  }
}

async function seedPosGasto(id: string, amount: string, category: string, incurredOn: string) {
  await pg.query(
    `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, $3, $4, $5, 'system')`,
    [id, ORG, amount, category, incurredOn],
  );
  const movId = CASH_MOV_MAP[id];
  if (movId) {
    await pg.query(
      `INSERT INTO cash_movements (id, session_id, organization_id, type, amount, reason, created_by, expense_id)
       VALUES ($1, $2, $3, 'expense', $4, 'supplies', 'cajero', $5)`,
      [movId, SESSION_ID, ORG, amount, id],
    );
  }
}

async function seedLegacyGasto(id: string, amount: string, category: string, incurredOn: string) {
  // No treasury_movements or cash_movements link — legacy direct insert
  await pg.query(
    `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, $3, $4, $5, 'owner')`,
    [id, ORG, amount, category, incurredOn],
  );
}

describe('listGastos (PGLite)', () => {
  it('returns all org-scoped gastos across all origins (no filters)', async () => {
    await seedBaseData();
    await seedTreasuryGasto(EXP_TREASURY, '100.00', 'servicios', '2026-06-01');
    await seedPosGasto(EXP_POS, '50.00', 'otros', '2026-06-02');
    await seedLegacyGasto(EXP_LEGACY, '30.00', 'transporte', '2026-06-03');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    expect(result.rows).toHaveLength(3);
    expect(result.total).toBeCloseTo(180, 2);
  });

  it('assigns origin label "treasury" to treasury-sourced gastos', async () => {
    await seedBaseData();
    await seedTreasuryGasto(EXP_TREASURY, '100.00', 'servicios', '2026-06-01');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    const row = result.rows.find(r => r.id === EXP_TREASURY);

    expect(row).toBeDefined();
    expect(row!.origin).toBe('treasury');
  });

  it('assigns origin label "pos" to POS-sourced gastos', async () => {
    await seedBaseData();
    await seedPosGasto(EXP_POS, '50.00', 'otros', '2026-06-02');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    const row = result.rows.find(r => r.id === EXP_POS);

    expect(row).toBeDefined();
    expect(row!.origin).toBe('pos');
  });

  it('assigns origin label "legacy" to gastos with no linked movement', async () => {
    await seedBaseData();
    await seedLegacyGasto(EXP_LEGACY, '30.00', 'transporte', '2026-06-03');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    const row = result.rows.find(r => r.id === EXP_LEGACY);

    expect(row).toBeDefined();
    expect(row!.origin).toBe('legacy');
  });

  it('filters by category — only matching rows returned', async () => {
    await seedBaseData();
    await seedTreasuryGasto(EXP_TREASURY, '100.00', 'servicios', '2026-06-01');
    await seedLegacyGasto(EXP_LEGACY, '30.00', 'transporte', '2026-06-03');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
      category: 'servicios',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.category).toBe('servicios');
    expect(result.total).toBeCloseTo(100, 2);
  });

  it('filters by date range — excludes gastos outside the range', async () => {
    await seedBaseData();
    await seedTreasuryGasto(EXP_TREASURY, '100.00', 'servicios', '2026-05-15'); // outside
    await seedLegacyGasto(EXP_LEGACY, '30.00', 'transporte', '2026-06-03'); // inside

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe(EXP_LEGACY);
  });

  it('is org-scoped — does not return gastos from another org', async () => {
    await seedBaseData();
    // Other org expense (no treasury_movements or cash_movements needed for scope isolation)
    await pg.query(
      `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
       VALUES ($1, $2, '200.00', 'arriendo', '2026-06-05', 'owner')`,
      [EXP_OTHER_ORG, OTHER_ORG],
    );
    await seedLegacyGasto(EXP_LEGACY, '30.00', 'transporte', '2026-06-03');

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows.some(r => r.id === EXP_OTHER_ORG)).toBe(false);
  });

  it('returns total = 0 and empty rows when no gastos in range', async () => {
    await seedBaseData();

    const result = await listGastos(db, {
      organizationId: ORG,
      start: '2026-06-01',
      end: '2026-06-30',
    });

    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
