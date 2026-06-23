/**
 * POS cash open/close idempotency + concurrent-open reconciliation (REQ-04).
 *
 * The mobile device opens a cash session OFFLINE and generates a
 * client_session_id. When the outbox replays the open/close events, the server
 * must:
 *   - dedupe a replayed open (same client_session_id → return the existing
 *     session, never a second row),
 *   - reconcile a CONCURRENT server-side open for the same caja (a DIFFERENT
 *     open session already exists → 409 session_conflict carrying that session
 *     so the device adopts it),
 *   - dedupe a replayed close (re-closing the same client_session_id returns the
 *     already-closed immutable record, not an error).
 *
 * Legacy clients (no client_session_id) keep the original behavior.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as CLOSE } from './close/route';
import { POST as OPEN } from './open/route';

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

const ORG = 'org_cash_idem_test';
const TOKEN = '22222222-2222-2222-2222-222222222222';
const CLIENT_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification');
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
    opening_explanation text,
    client_session_id uuid
  );

  CREATE UNIQUE INDEX cash_sessions_org_client_session_idx
    ON cash_sessions (organization_id, client_session_id)
    WHERE client_session_id IS NOT NULL;

  CREATE UNIQUE INDEX cash_sessions_one_open_per_token_idx
    ON cash_sessions (organization_id, pos_token_id)
    WHERE status = 'open' AND pos_token_id IS NOT NULL;

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

function openRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/pos/cash/open', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function closeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/pos/cash/close', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function openSessionCount(): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM cash_sessions WHERE organization_id = $1`,
    [ORG],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    'TRUNCATE treasury_movements; TRUNCATE treasury_accounts; TRUNCATE cash_movements; TRUNCATE cash_sessions; TRUNCATE pos_tokens; TRUNCATE app_settings;',
  );
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
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('POST /api/pos/cash/open — idempotency + reconciliation', () => {
  it('dedupes a replayed open with the same client_session_id (one session)', async () => {
    const first = await OPEN(openRequest({ openingAmount: 0, clientSessionId: CLIENT_A }));

    expect(first.status).toBe(201);

    const firstBody = await first.json();

    const second = await OPEN(openRequest({ openingAmount: 0, clientSessionId: CLIENT_A }));

    expect(second.status).toBe(200);

    const secondBody = await second.json();

    expect(secondBody.id).toBe(firstBody.id);
    expect(await openSessionCount()).toBe(1);
  });

  it('returns 409 session_conflict when a different open session exists for the caja', async () => {
    // A session opened from the dashboard (no client_session_id) already holds
    // the one-open-per-token slot.
    await pg.query(
      `INSERT INTO cash_sessions (organization_id, pos_token_id, opened_by, opening_amount, status)
       VALUES ($1, $2, 'dashboard', '0', 'open')`,
      [ORG, TOKEN],
    );
    const existing = await pg.query<{ id: string }>(
      `SELECT id FROM cash_sessions WHERE organization_id = $1 LIMIT 1`,
      [ORG],
    );
    const existingId = existing.rows[0]!.id;

    const res = await OPEN(openRequest({ openingAmount: 0, clientSessionId: CLIENT_B }));

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe('session_conflict');
    expect(body.session_id).toBe(existingId);
    // The device's offline open is NOT inserted — the server session wins.
    expect(await openSessionCount()).toBe(1);
  });

  it('keeps the legacy 400 when no client_session_id is sent and a caja is open', async () => {
    await OPEN(openRequest({ openingAmount: 0, clientSessionId: CLIENT_A }));

    const res = await OPEN(openRequest({ openingAmount: 0 }));

    expect(res.status).toBe(400);
  });
});

describe('POST /api/pos/cash/close — idempotency', () => {
  it('dedupes a replayed close (re-close returns the closed record, no error)', async () => {
    await OPEN(openRequest({ openingAmount: 0, clientSessionId: CLIENT_A }));

    const firstClose = await CLOSE(closeRequest({ countedAmount: 0, clientSessionId: CLIENT_A }));

    expect(firstClose.status).toBe(200);

    const firstBody = await firstClose.json();

    const secondClose = await CLOSE(closeRequest({ countedAmount: 0, clientSessionId: CLIENT_A }));

    expect(secondClose.status).toBe(200);

    const secondBody = await secondClose.json();

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.status).toBe('closed');
  });
});
