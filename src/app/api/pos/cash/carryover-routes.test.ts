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
  await pg.exec('TRUNCATE cash_sessions; TRUNCATE pos_tokens;');
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

describe('POST /api/pos/cash/open — carry-over enforcement glue (W2)', () => {
  it('rejects with 422 when the open count differs and no explanation is given', async () => {
    await seedClosedSession('3000000.00');

    const res = await POST(postBody({ openingAmount: 2900000 }));

    expect(res.status).toBe(422);
    expect(vi.mocked(logAction)).not.toHaveBeenCalled();
  });

  it('opens and audit-logs a discrepancy when the count differs but an explanation is given', async () => {
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
