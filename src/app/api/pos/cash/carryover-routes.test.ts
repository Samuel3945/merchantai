import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logAction } from '@/libs/audit-log';
import { GET } from './current/route';
import { POST } from './open/route';

// Integration coverage for the carry-over route glue (verify findings W1 + W2):
//   - GET /current must surface `expected_opening` (the device's prefill signal).
//   - POST /open must enforce the explanation gate and audit-log the right action.
// The handlers import the module singleton `db` and the auth/audit helpers; we
// inject an in-memory pglite db via a lazy (hoisted) getter, stub auth to supply
// the POS context, and stub only `logAction` so we can assert the call site.
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

const ORG = 'org_carryover_test';
const TOKEN = '11111111-1111-1111-1111-111111111111';

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
  -- treasury-sweep-model slice 1: treasury_accounts needed for getOrCreatePendingAccount
  -- (the open-time sweep lazy-seeds the transito account on first shortfall).
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
  -- slice 2: app_settings needed for resolveSweepDestination (global KV default)
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

async function seedClosedSession(counted: string): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (organization_id, pos_token_id, opened_by, opening_amount, status, counted_amount, closed_at)
     VALUES ($1, $2, 'cajero', '0', 'closed', $3, now())`,
    [ORG, TOKEN, counted],
  );
}

function postBody(body: unknown): Request {
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
  await pg.exec('TRUNCATE treasury_movements; TRUNCATE treasury_accounts; TRUNCATE cash_sessions; TRUNCATE pos_tokens; TRUNCATE app_settings;');
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
  vi.mocked(logAction).mockClear();
});

describe('GET /api/pos/cash/current — carry-over expected_opening (W1)', () => {
  it('returns expected_opening = last closed counted amount when no session is open', async () => {
    await seedClosedSession('3000000.00');

    const res = await GET(new Request('http://localhost/api/pos/cash/current'));
    const json = await res.json();

    expect(json.session).toBeNull();
    expect(json.expected).toBe(0);
    expect(json.expected_opening).toBe(3000000);
  });

  it('returns expected_opening 0 when there is no prior close', async () => {
    const res = await GET(new Request('http://localhost/api/pos/cash/current'));
    const json = await res.json();

    expect(json.expected_opening).toBe(0);
  });
});

describe('POST /api/pos/cash/open — carry-over enforcement glue (W2, slice 1 updated)', () => {
  // treasury-sweep-model slice 1 (ADR-2): 422 gate retired, cashier never blocked.
  it('opens (201) when the count differs and no explanation is given (no 422)', async () => {
    await seedClosedSession('3000000.00');

    const res = await POST(postBody({ openingAmount: 2900000 }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.opening_difference).toBe(-100000);
    // audit-log still fires on discrepancy
    expect(vi.mocked(logAction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAction).mock.calls[0]?.[0]).toMatchObject({
      action: 'cash_session_open_discrepancy',
      entityId: json.id,
    });
  });

  it('opens and audit-logs a discrepancy when the count differs with an explanation given', async () => {
    await seedClosedSession('3000000.00');

    const res = await POST(postBody({ openingAmount: 2900000, explanation: 'Faltaron 100k' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.opening_difference).toBe(-100000);
    expect(vi.mocked(logAction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAction).mock.calls[0]?.[0]).toMatchObject({
      action: 'cash_session_open_discrepancy',
      entityId: json.id,
    });
  });

  it('opens with action cash.opened when the count matches the carry-over', async () => {
    await seedClosedSession('3000000.00');

    const res = await POST(postBody({ openingAmount: 3000000 }));

    expect(res.status).toBe(201);
    expect(vi.mocked(logAction).mock.calls[0]?.[0]).toMatchObject({ action: 'cash.opened' });
  });

  it('allows a first-ever open (no prior close) without an explanation', async () => {
    const res = await POST(postBody({ openingAmount: 50000 }));

    expect(res.status).toBe(201);
    expect(vi.mocked(logAction).mock.calls[0]?.[0]).toMatchObject({ action: 'cash.opened' });
  });
});
