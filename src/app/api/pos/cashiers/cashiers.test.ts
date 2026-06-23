/**
 * GET /api/pos/cashiers — security regression guard (REQ-09).
 *
 * The cashier selector lists active employees, but the bcrypt PIN hash MUST NOT
 * leave through this endpoint — only `hasPin: boolean` (does the keypad need to
 * appear). The hash is delivered ONLY via /api/pos/employees/secrets. This test
 * locks that in so a future refactor cannot accidentally widen the select.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

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

const ORG = 'org_cashiers_test';

const SCHEMA = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    pin text DEFAULT '' NOT NULL,
    role text DEFAULT 'cashier' NOT NULL,
    active boolean DEFAULT true NOT NULL
  );
`;

let pg: PGlite;

function makeReq(): Request {
  return new Request('http://localhost/api/pos/cashiers', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM pos_users;');
  await pg.query(
    `INSERT INTO pos_users (organization_id, name, email, pin, role, active)
     VALUES ($1, 'Ana', 'ana@x.co', '$2b$10$secretHash', 'cashier', true)`,
    [ORG],
  );
  h.authCtx = {
    organizationId: ORG,
    cashierId: 'c1',
    cashierName: 'Tester',
    source: 'token',
    tokenId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('GET /api/pos/cashiers', () => {
  it('exposes hasPin but never the pin hash', async () => {
    const res = await GET(makeReq());

    expect(res.status).toBe(200);

    const body = await res.json();
    const cashier = body.cashiers[0];

    expect(cashier.hasPin).toBe(true);
    expect(cashier.pin).toBeUndefined();
    expect(cashier.pin_hash).toBeUndefined();
    expect(cashier.passwordHash).toBeUndefined();
    // The raw hash string must not appear anywhere in the serialized payload.
    expect(JSON.stringify(body)).not.toContain('$2b$10$secretHash');
  });
});
