/**
 * Slice 1 — Open-time Sweep Core (Strict TDD, RED phase)
 *
 * Tests validate:
 *   (a) Shortfall Δ<0 → handover row in transito, keyed to last-closed session id, amount=|Δ|
 *   (b) Δ=0 → no handover row inserted
 *   (c) Δ>0 surplus → no handover row; session opens
 *   (d) No prior close (first open) → no sweep, no block
 *   (e) No double-count: getTreasuryPosition after sweep = caja shows open_counted,
 *       transito shows |Δ|, company total unchanged
 *   (f) FLAG OFF regression: getTreasuryPosition with treasuryHandoverEnabled=false
 *       still subtracts handovers (no double-count after flag decoupling)
 *   (g) cashier never blocked: validateOpenCarryover returns valid=true regardless of
 *       counted vs expected
 *   (h) device sends legacy `explanation` field → 201, opening_explanation stored, no 422
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateOpenCarryover } from '@/libs/cash-helpers';
import { getTreasuryPosition } from '@/libs/treasury';
import { POST } from './open/route';

type TreasuryExecutor = Parameters<typeof getTreasuryPosition>[0];

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

const ORG = 'org_sweep_test';
const TOKEN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Full DDL — mirrors real schema columns exactly (drizzle_pglite_test_ddl_gotcha)
const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito');
  CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover');

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

  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification');

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
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

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

async function seedClosedSessionWithId(counted: string, sessionId: string): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (id, organization_id, pos_token_id, opened_by, opening_amount, status,
        counted_amount, closed_at)
     VALUES ($1, $2, $3, 'cajero', '0', 'closed', $4, now())`,
    [sessionId, ORG, TOKEN, counted],
  );
}

function openRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/cash/open', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE treasury_movements;
    TRUNCATE treasury_accounts;
    TRUNCATE cash_movements;
    TRUNCATE cash_sessions;
    TRUNCATE pos_tokens;
    TRUNCATE app_settings;
  `);
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN, ORG],
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Cajero',
    source: 'token',
    tokenId: TOKEN,
    cashierId: null,
  };
});

// ── (g) Pure-logic test: validateOpenCarryover is always valid ────────────────

describe('validateOpenCarryover — cashier never blocked (task 1.3)', () => {
  it('returns valid=true when counted equals expected', () => {
    const result = validateOpenCarryover({
      priorCloseExists: true,
      counted: 500,
      expected: 500,
      explanation: undefined,
    });

    expect(result.valid).toBe(true);

    if (result.valid) {
      expect(result.difference).toBe(0);
    }
  });

  it('returns valid=true when counted is less than expected AND no explanation given', () => {
    const result = validateOpenCarryover({
      priorCloseExists: true,
      counted: 400,
      expected: 500,
      explanation: undefined,
    });

    // After slice 1: should be valid=true, not 422 anymore
    expect(result.valid).toBe(true);

    if (result.valid) {
      expect(result.difference).toBe(-100);
    }
  });

  it('returns valid=true when counted is greater than expected AND no explanation', () => {
    const result = validateOpenCarryover({
      priorCloseExists: true,
      counted: 600,
      expected: 500,
      explanation: undefined,
    });

    expect(result.valid).toBe(true);

    if (result.valid) {
      expect(result.difference).toBe(100);
    }
  });

  it('returns valid=true on first open (priorCloseExists=false)', () => {
    const result = validateOpenCarryover({
      priorCloseExists: false,
      counted: 500,
      expected: 0,
      explanation: undefined,
    });

    expect(result.valid).toBe(true);
  });
});

// ── (a) Shortfall Δ<0 → handover row in transito keyed to last-closed session ──

describe('POST /api/pos/cash/open — shortfall sweep (a)', () => {
  it('emits a handover movement to transito when Δ<0, keyed to the last-closed session', async () => {
    const CLOSED_SESSION = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await seedClosedSessionWithId('500', CLOSED_SESSION);

    const res = await POST(openRequest({ openingAmount: 400 }));
    const json = await res.json();

    expect(res.status).toBe(201);

    // One transito account must have been created
    const accounts = await pg.query<{ id: string }>(
      `SELECT id FROM treasury_accounts WHERE organization_id = $1 AND type = 'transito'`,
      [ORG],
    );

    expect(accounts.rows.length).toBe(1);

    const transitoId = accounts.rows[0]!.id;

    // One handover movement: from=NULL, to=transito, amount=100, keyed to CLOSED_SESSION
    const movements = await pg.query<{
      from_account_id: string | null;
      to_account_id: string;
      amount: string;
      cash_session_id: string;
    }>(
      `SELECT from_account_id, to_account_id, amount, cash_session_id
         FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(1);
    expect(movements.rows[0]!.from_account_id).toBeNull();
    expect(movements.rows[0]!.to_account_id).toBe(transitoId);
    expect(movements.rows[0]!.amount).toBe('100.00');
    // Keyed to the LAST CLOSED session, NOT the newly opened session
    expect(movements.rows[0]!.cash_session_id).toBe(CLOSED_SESSION);

    // The new session is returned
    expect(json.id).toBeDefined();
    expect(json.id).not.toBe(CLOSED_SESSION);
  });

  it('emits a shortfall sweep with empty drawer (open_counted=0, prior=300)', async () => {
    await seedClosedSessionWithId('300', 'dddddddd-dddd-dddd-dddd-dddddddddddd');

    const res = await POST(openRequest({ openingAmount: 0 }));

    expect(res.status).toBe(201);

    const movements = await pg.query<{ amount: string }>(
      `SELECT amount FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(1);
    expect(movements.rows[0]!.amount).toBe('300.00');
  });
});

// ── (b) Δ=0 → no handover row ─────────────────────────────────────────────────

describe('POST /api/pos/cash/open — zero delta (b)', () => {
  it('does NOT emit a handover movement when counted equals expected', async () => {
    await seedClosedSessionWithId('400', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');

    const res = await POST(openRequest({ openingAmount: 400 }));

    expect(res.status).toBe(201);

    const movements = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(0);
  });
});

// ── (c) Δ>0 surplus → no handover row; session opens ─────────────────────────

describe('POST /api/pos/cash/open — surplus (c)', () => {
  it('does NOT emit a handover movement when counted > expected', async () => {
    await seedClosedSessionWithId('300', 'ffffffff-ffff-ffff-ffff-ffffffffffff');

    const res = await POST(openRequest({ openingAmount: 450 }));

    expect(res.status).toBe(201);

    const movements = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(0);
  });
});

// ── (d) No prior close (first open) → no sweep, no block ─────────────────────

describe('POST /api/pos/cash/open — first open ever (d)', () => {
  it('opens without sweep and without blocking when no prior close exists', async () => {
    // No closed session seeded
    const res = await POST(openRequest({ openingAmount: 50000 }));

    expect(res.status).toBe(201);

    const movements = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(0);
  });
});

// ── (e) No double-count: getTreasuryPosition after sweep ──────────────────────

describe('getTreasuryPosition — no double-count after open-time sweep (e)', () => {
  it('caja balance equals open_counted, transito equals |Δ|, company total unchanged', async () => {
    // Setup: close session with 500 counted
    const CLOSED = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await seedClosedSessionWithId('500', CLOSED);

    // Open with 400 → Δ=-100 → sweep should emit 100 to transito
    const res = await POST(openRequest({ openingAmount: 400 }));

    expect(res.status).toBe(201);

    // getTreasuryPosition must reflect the new state
    const position = await getTreasuryPosition(h.db as unknown as TreasuryExecutor, ORG);

    const caja = position.find(a => a.key.startsWith('caja:'));
    const transito = position.find(a => a.type === 'transito');

    // Caja: open session's expected = 400 (the open amount)
    expect(caja).toBeDefined();
    expect(caja!.balance).toBe(400);

    // Transito: holds the 100 sweep
    expect(transito).toBeDefined();
    expect(transito!.balance).toBe(100);

    // Company total unchanged vs pre-open (caja=400 + transito=100 = 500 = original counted)
    const total = position.reduce((sum, a) => sum + a.balance, 0);

    expect(total).toBe(500);
  });
});

// ── (f) FLAG OFF regression: getTreasuryPosition subtracts handovers even with
//        treasuryHandoverEnabled=false (decoupled from flag) ───────────────────

describe('getTreasuryPosition — flag-off regression after flag decoupling (f)', () => {
  it('still subtracts handovers from caja balance even when flag=false', async () => {
    // Seed a closed session and a handover movement directly (simulating a
    // prior sweep that was recorded before the flag was toggled off)
    const CLOSED = '11111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await seedClosedSessionWithId('500', CLOSED);

    // Manually seed a transito account and a handover movement keyed to CLOSED
    await pg.query(
      `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
       VALUES ('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $1, 'transito', 'Pendiente de ubicar', '0', true)`,
      [ORG],
    );
    await pg.query(
      `INSERT INTO treasury_movements
         (organization_id, from_account_id, to_account_id, amount, type, cash_session_id, created_by)
       VALUES ($1, NULL, '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '100', 'handover', $2, 'test')`,
      [ORG, CLOSED],
    );

    // Ensure the flag is explicitly OFF (no row = false, but also test explicitly)
    // No app_settings row → flag defaults to false

    // Open the session to mark it as open (so cajaBalance sees the open session)
    await pg.query(
      `INSERT INTO cash_sessions
         (organization_id, pos_token_id, opened_by, opening_amount, status)
       VALUES ($1, $2, 'cajero', '400', 'open')`,
      [ORG, TOKEN],
    );

    const position = await getTreasuryPosition(h.db as unknown as TreasuryExecutor, ORG);

    const caja = position.find(a => a.key.startsWith('caja:'));
    const transito = position.find(a => a.type === 'transito');

    // With flag decoupled: caja shows 400 (open amount), transito shows 100
    // No double-count even though treasuryHandoverEnabled=false
    expect(caja).toBeDefined();
    expect(caja!.balance).toBe(400);

    expect(transito).toBeDefined();
    expect(transito!.balance).toBe(100);
  });
});

// ── (h) Legacy device sends explanation field → 201, stored, no 422 ──────────

describe('POST /api/pos/cash/open — legacy explanation field backward-compat (h)', () => {
  it('accepts and stores explanation from old device without 422, even on shortfall', async () => {
    await seedClosedSessionWithId('500', 'cccccccc-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    const res = await POST(
      openRequest({ openingAmount: 400, explanation: 'Se usaron 100 para cambio' }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.opening_explanation).toBe('Se usaron 100 para cambio');
  });

  it('accepts a request without explanation field on shortfall (no 422)', async () => {
    await seedClosedSessionWithId('500', 'dddddddd-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    // No explanation field at all — old devices omit it
    const res = await POST(openRequest({ openingAmount: 300 }));

    expect(res.status).toBe(201);
  });
});
