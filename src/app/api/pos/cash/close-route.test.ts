import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './close/route';

// Integration coverage for the highest-risk path of Option B (verify W1/W2):
// closing a POS cash session MUST emit a `handover` movement into the org's
// `transito` ("Pendiente de ubicar") account — inside the same transaction, and
// skipped when the drawer is empty. A regression here makes money silently
// disappear from the ledger for POS-closed sessions.
const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({ get db() {
  return h.db;
} }));
vi.mock('@/libs/pos-auth', () => ({
  requirePosAuth: vi.fn(async () => ({ ctx: h.authCtx, errorResponse: null })),
}));
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
}));

const ORG = 'org_close_handover_test';
const TOKEN = '22222222-2222-2222-2222-222222222222';
const SESSION = '33333333-3333-3333-3333-333333333333';

// FK REFERENCES across tables are stripped (plain uuid) so we don't need stub
// tables; the treasury_movements CHECK is kept because the handover insert must
// satisfy it (from=null, to=transito, type='handover').
const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification');
  CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito');
  CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover');

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
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
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

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

async function seedOpenSession(id: string): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
    [id, ORG, TOKEN],
  );
}

function closeRequest(countedAmount: number | string): Request {
  return new Request('http://localhost/api/pos/cash/close', {
    method: 'POST',
    body: JSON.stringify({ countedAmount }),
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

async function enableHandoverFlag(): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, 'treasuryHandoverEnabled', 'true')
     ON CONFLICT (organization_id, key) DO UPDATE SET value = 'true'`,
    [ORG],
  );
}

beforeEach(async () => {
  await pg.exec('TRUNCATE treasury_movements; TRUNCATE treasury_accounts; TRUNCATE cash_movements; TRUNCATE cash_sessions; TRUNCATE pos_tokens; TRUNCATE app_settings;');
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

describe('POST /api/pos/cash/close — flag OFF (default carry-over, no handover)', () => {
  it('does NOT emit a handover movement when the flag is off (default)', async () => {
    await seedOpenSession(SESSION);
    // No app_settings row → flag = false

    const res = await POST(closeRequest(3000000));

    expect(res.status).toBe(200);

    const movements = await pg.query(`SELECT 1 FROM treasury_movements WHERE type = 'handover'`);

    expect(movements.rows.length).toBe(0);

    const accounts = await pg.query(`SELECT 1 FROM treasury_accounts WHERE type = 'transito'`);

    expect(accounts.rows.length).toBe(0);
  });
});

describe('POST /api/pos/cash/close — handover into the transito account (flag ON)', () => {
  it('emits a handover movement to a lazy-seeded transito account when counted > 0', async () => {
    await enableHandoverFlag();
    await seedOpenSession(SESSION);

    const res = await POST(closeRequest(3000000));

    expect(res.status).toBe(200);

    const accounts = await pg.query<{ id: string }>(
      `SELECT id FROM treasury_accounts WHERE organization_id = $1 AND type = 'transito'`,
      [ORG],
    );

    expect(accounts.rows.length).toBe(1);

    const transitoId = accounts.rows[0]!.id;

    const movements = await pg.query<{
      from_account_id: string | null;
      to_account_id: string;
      amount: string;
      cash_session_id: string;
    }>(`SELECT from_account_id, to_account_id, amount, cash_session_id FROM treasury_movements WHERE type = 'handover'`);

    expect(movements.rows.length).toBe(1);
    expect(movements.rows[0]!.from_account_id).toBeNull();
    expect(movements.rows[0]!.to_account_id).toBe(transitoId);
    expect(movements.rows[0]!.amount).toBe('3000000.00');
    expect(movements.rows[0]!.cash_session_id).toBe(SESSION);
  });

  it('does NOT emit a handover (nor seed transito) when the drawer is empty (counted = 0)', async () => {
    await enableHandoverFlag();
    await seedOpenSession(SESSION);

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(200);

    const movements = await pg.query(`SELECT 1 FROM treasury_movements WHERE type = 'handover'`);

    expect(movements.rows.length).toBe(0);

    const accounts = await pg.query(`SELECT 1 FROM treasury_accounts WHERE type = 'transito'`);

    expect(accounts.rows.length).toBe(0);
  });

  it('reuses the single org transito account across multiple closes (idempotent seed)', async () => {
    await enableHandoverFlag();
    await seedOpenSession(SESSION);
    await POST(closeRequest(1000000));

    const SESSION_2 = '44444444-4444-4444-4444-444444444444';
    await seedOpenSession(SESSION_2);
    await POST(closeRequest(2000000));

    const accounts = await pg.query(`SELECT 1 FROM treasury_accounts WHERE type = 'transito'`);

    expect(accounts.rows.length).toBe(1);

    const movements = await pg.query(`SELECT 1 FROM treasury_movements WHERE type = 'handover'`);

    expect(movements.rows.length).toBe(2);
  });
});
