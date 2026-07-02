/**
 * Slice 3 — Inflows Model: POS Entrada with Origin (Strict TDD, RED phase)
 *
 * Tests validate:
 *   (a) INTERNAL origin — companion treasury salida debits source container;
 *       cash_movements entrada created; treasury_movement_id stored on the row
 *   (b) EXTERNAL origin — plain caja entrada only; no source treasury debit
 *   (c) Legacy entrada (no origin/motivo fields) still works — backward-compat
 *   (d) Missing reason → 400
 *   (e) INTERNAL without fromAccountId → 400
 *   (f) Cross-tenant / inactive source → 400
 *   (g) INTERNAL source with insufficient balance → 400
 *   (h) Invariant: only movimientos POS can add cash to a caja
 *       (test: no other inflow path — assert treasury_movements has no
 *       phantom caja-credit row for a plain legacy entrada)
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeNetProfit } from '@/libs/net-profit';
import { POST } from './movement/route';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/libs/pos-auth', () => ({
  requirePosAuth: vi.fn(async () => ({ ctx: h.authCtx, errorResponse: null })),
}));
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
}));

const ORG = 'org_inflows_test';
const TOKEN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const COFRE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const BANCO_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const INACTIVE_ACCOUNT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const OTHER_ORG_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

// Full DDL — must mirror real schema exactly (drizzle_pglite_test_ddl_gotcha).
// cash_movements now includes origin and treasury_movement_id columns (slice 3).
const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito');
  CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','credito_payment','reclassification');

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid,
    pos_token_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_accounts_org_name_unique UNIQUE (organization_id, name)
  );

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    default_sweep_destination_account_id uuid REFERENCES treasury_accounts(id) ON DELETE SET NULL
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
    opened_by_actor_id text,
    closed_by_actor_id text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text,
    client_session_id uuid
  );

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account_id uuid,
    to_account_id uuid,
    amount numeric(12,2) NOT NULL,
    type "treasury_movement_type" NOT NULL,
    category text,
    reason text,
    expense_id uuid,
    transfer_reconciliation_id uuid,
    handover_movement_id uuid,
    cash_session_id uuid,
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

  CREATE TABLE suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active' NOT NULL
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

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
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
    -- Slice 3: inflow origin ('internal' | 'external') — null for legacy rows
    origin text,
    -- Slice 3: links an internal-origin entrada to the companion treasury debit
    treasury_movement_id uuid,
    -- gasto-treasury-unification slice 1: links POS expense to P&L anchor row
    expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL DEFAULT '',
    pin text NOT NULL DEFAULT '',
    role text NOT NULL DEFAULT 'cashier',
    active boolean DEFAULT true NOT NULL,
    salary numeric(12, 2)
  );

  -- supplier_payables: needed by the route's getSupplierOutstanding call when
  -- supplierId is present. No supplier_payments here (not tested in this suite).
  CREATE TABLE supplier_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    invoice_number text,
    purchased_at timestamp DEFAULT now() NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE supplier_payables (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    stock_movement_id uuid,
    total_amount numeric(12,2) NOT NULL,
    paid_amount numeric(12,2) DEFAULT '0' NOT NULL,
    credited_amount numeric(12,2) DEFAULT '0' NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    purchased_at timestamp DEFAULT now() NOT NULL,
    purchase_id uuid REFERENCES supplier_purchases(id) ON DELETE SET NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  -- supplier_payments: needed because recordCajaPayableSettle inserts here when
  -- a settle path is taken. Must mirror migration 0071 schema (dual funding).
  CREATE TABLE supplier_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    treasury_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT supplier_payments_funding_source_chk
      CHECK (num_nonnulls(treasury_movement_id, cash_movement_id) = 1)
  );
`;

let pg: PGlite;

function movementRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/cash/movement', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function seedOpenSession(): Promise<void> {
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name)
     VALUES ($1, $2, 'Caja 1')`,
    [TOKEN, ORG],
  );
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'Cajero', '0', 'open')`,
    [SESSION_ID, ORG, TOKEN],
  );
}

async function seedCofre(id: string, balance = '500', active = true): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
     VALUES ($1, $2, 'caja_fuerte', 'Bóveda principal', $3, $4)`,
    [id, ORG, balance, active],
  );
}

async function seedBanco(id: string, balance = '1000'): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
     VALUES ($1, $2, 'banco', 'Cuenta bancaria', $3, true)`,
    [id, ORG, balance],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  // FK-safe order: children first (cash_movements.expense_id → expenses)
  await pg.exec('DELETE FROM supplier_payments');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM supplier_purchases');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM app_settings');
  await pg.exec('DELETE FROM suppliers');
  await pg.exec('DELETE FROM pos_users');
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Cajero',
    source: 'token',
    tokenId: TOKEN,
    cashierId: null,
  };
  await seedOpenSession();
});

// ── (c) Legacy backward-compat: no origin/motivo fields still works ────────────

describe('(c) legacy entrada — no origin field — backward-compat', () => {
  it('returns 201 and creates a cash_movements row for a plain deposit', async () => {
    const res = await POST(movementRequest({ type: 'deposit', amount: 100, reason: 'Apertura' }));

    expect(res.status).toBe(201);

    const { rows } = await pg.query<{ type: string; origin: string | null }>(
      'SELECT type, origin FROM cash_movements',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('deposit');
    expect(rows[0]?.origin).toBeNull();
  });

  it('records NO treasury debit when no origin is provided', async () => {
    await POST(movementRequest({ type: 'deposit', amount: 200, reason: 'Float inicial' }));

    const { rows } = await pg.query('SELECT * FROM treasury_movements');

    expect(rows).toHaveLength(0);
  });
});

// ── (d) Missing reason → 400 ───────────────────────────────────────────────────

describe('(d) reason required', () => {
  it('returns 400 when reason is missing on any type', async () => {
    const res = await POST(movementRequest({ type: 'deposit', amount: 100 }));

    expect(res.status).toBe(400);
  });

  it('returns 400 when reason is blank for EXTERNAL origin', async () => {
    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 100,
      reason: '   ',
      origin: { kind: 'external' },
    }));

    expect(res.status).toBe(400);
  });
});

// ── (b) EXTERNAL origin — plain caja entrada, no source debit ─────────────────

describe('(b) EXTERNAL origin — owner injection', () => {
  it('creates a cash_movements row with origin=external and no treasury debit', async () => {
    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 300,
      reason: 'Inyección de capital',
      origin: { kind: 'external' },
    }));

    expect(res.status).toBe(201);

    const { rows: cm } = await pg.query<{ origin: string; treasury_movement_id: string | null }>(
      'SELECT origin, treasury_movement_id FROM cash_movements',
    );

    expect(cm).toHaveLength(1);
    expect(cm[0]?.origin).toBe('external');
    expect(cm[0]?.treasury_movement_id).toBeNull();

    const { rows: tm } = await pg.query('SELECT * FROM treasury_movements');

    expect(tm).toHaveLength(0);
  });
});

// ── (a) INTERNAL origin — companion treasury salida debits source ──────────────

describe('(a) INTERNAL origin — container transfer', () => {
  it('from cofre: cash_movements created + treasury_movements salida debits cofre', async () => {
    await seedCofre(COFRE_ID, '500');

    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 200,
      reason: 'Traslado desde bóveda',
      origin: { kind: 'internal', fromAccountId: COFRE_ID },
    }));

    expect(res.status).toBe(201);

    // cash_movements: one deposit with origin=internal
    const { rows: cm } = await pg.query<{
      origin: string;
      treasury_movement_id: string | null;
      amount: string;
    }>('SELECT origin, treasury_movement_id, amount FROM cash_movements');

    expect(cm).toHaveLength(1);
    expect(cm[0]?.origin).toBe('internal');
    expect(cm[0]?.treasury_movement_id).not.toBeNull();

    // treasury_movements: one salida from cofre (fromAccountId=COFRE, toAccountId=null)
    const { rows: tm } = await pg.query<{
      from_account_id: string;
      to_account_id: string | null;
      type: string;
      amount: string;
    }>('SELECT from_account_id, to_account_id, type, amount FROM treasury_movements');

    expect(tm).toHaveLength(1);
    expect(tm[0]?.from_account_id).toBe(COFRE_ID);
    expect(tm[0]?.to_account_id).toBeNull();
    expect(tm[0]?.type).toBe('salida');
    expect(Number.parseFloat(tm[0]?.amount ?? '0')).toBe(200);
  });

  it('from banco: companion treasury debit recorded', async () => {
    await seedBanco(BANCO_ID, '1000');

    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 500,
      reason: 'Descargue del banco',
      origin: { kind: 'internal', fromAccountId: BANCO_ID },
    }));

    expect(res.status).toBe(201);

    const { rows: tm } = await pg.query<{ from_account_id: string; type: string }>(
      'SELECT from_account_id, type FROM treasury_movements',
    );

    expect(tm).toHaveLength(1);
    expect(tm[0]?.from_account_id).toBe(BANCO_ID);
    expect(tm[0]?.type).toBe('salida');
  });

  it('treasury_movement_id on cash_movements links to the treasury row', async () => {
    await seedCofre(COFRE_ID, '300');

    await POST(movementRequest({
      type: 'deposit',
      amount: 100,
      reason: 'Traslado',
      origin: { kind: 'internal', fromAccountId: COFRE_ID },
    }));

    const { rows: cm } = await pg.query<{ treasury_movement_id: string }>(
      'SELECT treasury_movement_id FROM cash_movements',
    );
    const { rows: tm } = await pg.query<{ id: string }>(
      'SELECT id FROM treasury_movements',
    );

    expect(cm[0]?.treasury_movement_id).toBe(tm[0]?.id);
  });
});

// ── (e) INTERNAL without fromAccountId → 400 ──────────────────────────────────

describe('(e) INTERNAL origin missing fromAccountId', () => {
  it('returns 400', async () => {
    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 100,
      reason: 'Sin origen',
      origin: { kind: 'internal' },
    }));

    expect(res.status).toBe(400);
  });
});

// ── (f) Cross-tenant / inactive source → 400 ──────────────────────────────────

describe('(f) invalid source account', () => {
  it('returns 400 for an inactive source account', async () => {
    await seedCofre(INACTIVE_ACCOUNT_ID, '500', false);

    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 100,
      reason: 'Traslado',
      origin: { kind: 'internal', fromAccountId: INACTIVE_ACCOUNT_ID },
    }));

    expect(res.status).toBe(400);
  });

  it('returns 400 for a cross-tenant account id', async () => {
    // OTHER_ORG_ACCOUNT_ID belongs to a different org — not seeded in ORG
    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 100,
      reason: 'Traslado',
      origin: { kind: 'internal', fromAccountId: OTHER_ORG_ACCOUNT_ID },
    }));

    expect(res.status).toBe(400);
  });
});

// ── (g) INTERNAL source with insufficient balance → 400 ───────────────────────

describe('(g) insufficient source balance', () => {
  it('returns 400 when cofre balance is less than requested amount', async () => {
    await seedCofre(COFRE_ID, '50'); // only 50 available

    const res = await POST(movementRequest({
      type: 'deposit',
      amount: 200, // more than available
      reason: 'Traslado',
      origin: { kind: 'internal', fromAccountId: COFRE_ID },
    }));

    expect(res.status).toBe(400);
  });
});

// ── (h) Invariant: only POS movimientos can add cash to a caja ─────────────────

describe('(h) caja inflow invariant', () => {
  it('plain legacy entry creates NO treasury_movements row (no phantom caja-credit)', async () => {
    // A plain deposit (type=deposit, no origin) only touches cash_movements.
    // This asserts the invariant: no direct treasury credit to a caja account.
    await POST(movementRequest({ type: 'deposit', amount: 100, reason: 'Apertura' }));

    const { rows } = await pg.query('SELECT * FROM treasury_movements');

    expect(rows).toHaveLength(0);
  });

  it('EXTERNAL origin entry creates NO treasury_movements row', async () => {
    await POST(movementRequest({
      type: 'deposit',
      amount: 150,
      reason: 'Sobrante de apertura',
      origin: { kind: 'external' },
    }));

    const { rows } = await pg.query('SELECT * FROM treasury_movements');

    expect(rows).toHaveLength(0);
  });
});

// ── gasto-treasury-unification slice 1: POS→P&L bridge (RED) ─────────────────
//
// Task 1.2.1 — type='expense' creates exactly 1 expenses row linked by expense_id
// Task 1.2.2 — atomicity: expenses insert failure rolls back cash_movements
// Task 1.2.3 — excluded types produce zero expenses rows
// Task 1.2.4 — bridged POS gasto counted exactly once in computeNetProfit

describe('(i) POS expense bridge — happy path', () => {
  it('creates exactly one expenses row with correct amount, category=otros, description=reason', async () => {
    const res = await POST(movementRequest({
      type: 'expense',
      amount: 150,
      reason: 'supplies',
    }));

    expect(res.status).toBe(201);

    const { rows: exp } = await pg.query<{
      amount: string;
      category: string;
      description: string | null;
      organization_id: string;
    }>('SELECT amount, category, description, organization_id FROM expenses');

    expect(exp).toHaveLength(1);
    expect(Number.parseFloat(exp[0]!.amount)).toBe(150);
    expect(exp[0]!.category).toBe('otros');
    expect(exp[0]!.description).toBe('supplies');
    expect(exp[0]!.organization_id).toBe(ORG);
  });

  it('cash_movements expense_id links to the new expenses row', async () => {
    await POST(movementRequest({ type: 'expense', amount: 75, reason: 'office supplies' }));

    const { rows: cm } = await pg.query<{ expense_id: string | null }>(
      'SELECT expense_id FROM cash_movements WHERE type = $1',
      ['expense'],
    );
    const { rows: exp } = await pg.query<{ id: string }>('SELECT id FROM expenses');

    expect(cm).toHaveLength(1);
    expect(exp).toHaveLength(1);
    expect(cm[0]!.expense_id).toBe(exp[0]!.id);
  });

  it('both rows share the same org scope', async () => {
    await POST(movementRequest({ type: 'expense', amount: 50, reason: 'cleaning' }));

    const { rows: cm } = await pg.query<{ organization_id: string }>(
      'SELECT organization_id FROM cash_movements WHERE type = $1',
      ['expense'],
    );
    const { rows: exp } = await pg.query<{ organization_id: string }>(
      'SELECT organization_id FROM expenses',
    );

    expect(cm[0]!.organization_id).toBe(exp[0]!.organization_id);
    expect(exp[0]!.organization_id).toBe(ORG);
  });
});

describe('(j2) POS expense bridge — supplier link is preserved', () => {
  it('keeps supplier_id on the cash_movements row when type=expense carries a supplierId', async () => {
    const SUPPLIER_ID = '00000000-0000-0000-0007-000000000001';
    await pg.query(
      `INSERT INTO suppliers (id, organization_id, name, status)
       VALUES ($1, $2, 'Proveedor X', 'active')`,
      [SUPPLIER_ID, ORG],
    );

    const res = await POST(movementRequest({
      type: 'expense',
      amount: 300,
      reason: 'Pago a proveedor',
      supplierId: SUPPLIER_ID,
    }));

    expect(res.status).toBe(201);

    const { rows: cm } = await pg.query<{ supplier_id: string | null; expense_id: string | null }>(
      'SELECT supplier_id, expense_id FROM cash_movements WHERE type = $1',
      ['expense'],
    );

    expect(cm).toHaveLength(1);
    // The supplier link must survive the bridge (else it vanishes from
    // the gasto-KPI pagosProveedores aggregation).
    expect(cm[0]!.supplier_id).toBe(SUPPLIER_ID);
    // And the P&L anchor link must still be set.
    expect(cm[0]!.expense_id).not.toBeNull();
  });
});

describe('(j) POS expense bridge — excluded types produce zero expenses rows', () => {
  for (const excludedType of ['salary', 'inventory_purchase', 'withdrawal', 'advance'] as const) {
    it(`type='${excludedType}' creates exactly zero expenses rows`, async () => {
      const res = await POST(movementRequest({ type: excludedType, amount: 100, reason: 'test' }));

      // Movement itself is created
      expect(res.status).toBe(201);

      const { rows: exp } = await pg.query('SELECT id FROM expenses');

      expect(exp).toHaveLength(0);

      // cash_movements row exists but expense_id is null
      const { rows: cm } = await pg.query<{ expense_id: string | null }>(
        'SELECT expense_id FROM cash_movements WHERE type = $1',
        [excludedType],
      );

      expect(cm).toHaveLength(1);
      expect(cm[0]!.expense_id).toBeNull();
    });
  }
});

describe('(k) POS expense bridge — P&L net-profit includes bridged POS gasto exactly once', () => {
  it('computeNetProfit expenses field equals the bridged POS gasto amount', async () => {
    await POST(movementRequest({ type: 'expense', amount: 200, reason: 'maintenance' }));

    // 0 gross margin, 0 salaries. Net = 0 - 0 - 200 = -200
    const stats = await computeNetProfit(ORG, '2000-01-01', '2099-12-31', 0);

    expect(stats.expenses).toBe(200);
    expect(stats.net).toBe(-200);
  });
});
