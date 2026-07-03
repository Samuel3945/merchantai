/**
 * GET /api/agent/deliveries/last
 *
 * Covers:
 *   1. most recent delivery for the phone → found:true with name/address
 *   2. a different phone with no delivery → found:false
 *   3. missing phone → 400
 *   4. capabilities.orders=false → 403
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_last_delivery_test';
const PHONE = '3001234567';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  capabilities: { orders: true } as Record<string, boolean>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/agent-auth', () => ({
  requireAgentAuth: vi.fn(async () => ({
    ctx: {
      organizationId: ORG,
      channelId: 'aaaaaaaa-0001-0001-0001-ffffffffffff',
      capabilities: h.capabilities,
      tokenId: 'aaaaaaaa-0002-0002-0002-ffffffffffff',
    },
    errorResponse: null,
  })),
}));

const SCHEMA = `
  CREATE TABLE delivery_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_phone text,
    customer_name text,
    status text DEFAULT 'pending' NOT NULL,
    address text NOT NULL,
    address_notes text,
    items jsonb DEFAULT '[]' NOT NULL,
    subtotal numeric(12, 2) DEFAULT '0' NOT NULL,
    delivery_fee numeric(12, 2) DEFAULT '0' NOT NULL,
    total numeric(12, 2) DEFAULT '0' NOT NULL,
    source text DEFAULT 'manual' NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  h.capabilities = { orders: true };
  await pg.exec('DELETE FROM delivery_orders;');
});

async function insertOrder(opts: {
  phone: string;
  name: string;
  address: string;
  addressNotes?: string | null;
  createdAt: string;
}): Promise<void> {
  await pg.query(
    `INSERT INTO delivery_orders
       (organization_id, customer_phone, customer_name, address, address_notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [ORG, opts.phone, opts.name, opts.address, opts.addressNotes ?? null, opts.createdAt],
  );
}

function getRequest(phone: string | null): Request {
  const qs = phone === null ? '' : `?phone=${encodeURIComponent(phone)}`;
  return new Request(`http://localhost/api/agent/deliveries/last${qs}`, {
    headers: { authorization: 'Bearer test' },
  });
}

describe('GET /api/agent/deliveries/last', () => {
  it('returns the MOST RECENT delivery name/address for the phone', async () => {
    await insertOrder({ phone: PHONE, name: 'Vieja', address: 'Calle 1', createdAt: '2024-01-01T00:00:00Z' });
    await insertOrder({
      phone: PHONE,
      name: 'Samuel Alzate',
      address: 'Brisas de Galicia Bloq V apt 407',
      addressNotes: '4o piso',
      createdAt: '2024-06-01T00:00:00Z',
    });

    const { GET } = await import('./route');
    const res = await GET(getRequest(PHONE));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      found: true,
      name: 'Samuel Alzate',
      address: 'Brisas de Galicia Bloq V apt 407',
      addressNotes: '4o piso',
    });
  });

  it('a phone with no delivery → found:false', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest('3009999999'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ found: false });
  });

  it('missing phone → 400', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest(null));

    expect(res.status).toBe(400);
  });

  it('capabilities.orders=false → 403', async () => {
    h.capabilities = { orders: false };
    const { GET } = await import('./route');
    const res = await GET(getRequest(PHONE));

    expect(res.status).toBe(403);
  });
});
