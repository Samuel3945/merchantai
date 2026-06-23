/**
 * GET /api/pos/employees/secrets — device-scoped employee PIN hashes (REQ-09).
 *
 * Returns ONLY { id, pin_hash } for ACTIVE employees of the device's org that
 * have a PIN set. The hashes are fetched on a dedicated, audited path so they
 * never co-travel with the bulk catalog and land straight into the device's
 * hardware-backed secure store (never SQLite plaintext).
 *
 * Cross-org isolation and the "active + has-pin only" filter are the security
 * contract proven here against PGLite with the REAL query.
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

const ORG = 'org_secrets_test';
const OTHER_ORG = 'org_other';

const SCHEMA = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text DEFAULT '' NOT NULL,
    pin text DEFAULT '' NOT NULL,
    role text DEFAULT 'cashier' NOT NULL,
    active boolean DEFAULT true NOT NULL
  );
`;

let pg: PGlite;

function makeReq(): Request {
  return new Request('http://localhost/api/pos/employees/secrets', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  });
}

async function seedUser(
  org: string,
  name: string,
  pin: string,
  active = true,
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO pos_users (organization_id, name, email, pin, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [org, name, `${name}@x.co`, pin, active],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM pos_users;');
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

describe('GET /api/pos/employees/secrets', () => {
  it('returns id + pin_hash for active employees of the device org', async () => {
    const a = await seedUser(ORG, 'Ana', '$2b$10$hashAna');
    const b = await seedUser(ORG, 'Beto', '$2b$10$hashBeto');

    const res = await GET(makeReq());

    expect(res.status).toBe(200);

    const body = await res.json();
    const byId = Object.fromEntries(
      body.secrets.map((s: { id: string; pin_hash: string }) => [s.id, s.pin_hash]),
    );

    expect(byId[a]).toBe('$2b$10$hashAna');
    expect(byId[b]).toBe('$2b$10$hashBeto');
    expect(body.secrets).toHaveLength(2);
  });

  it('excludes inactive employees, empty-PIN employees, and other orgs', async () => {
    const active = await seedUser(ORG, 'Ana', '$2b$10$hashAna');
    await seedUser(ORG, 'Inactivo', '$2b$10$hashOff', false);
    await seedUser(ORG, 'SinPin', '');
    await seedUser(OTHER_ORG, 'Ajeno', '$2b$10$hashAjeno');

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0].id).toBe(active);
  });
});
