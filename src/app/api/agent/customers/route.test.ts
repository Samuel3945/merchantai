/**
 * GET + POST /api/agent/customers
 *
 * Agent-auth customer endpoints (no pos_token required).
 * Tests:
 *   1. GET search returns only the caller-org customers (org_other excluded).
 *   2. GET with search param filters by name/whatsapp/document/email.
 *   3. POST creates a customer in the org and returns the row.
 *   4. POST with missing name → 400.
 *   5. 401 without auth on GET and POST.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_agent_customers_test';
const CHANNEL_ID = 'cccccccc-0001-4001-8001-000000000001';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authed: true,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/agent-auth', () => ({
  requireAgentAuth: vi.fn(async () => {
    if (!h.authed) {
      return {
        ctx: null,
        errorResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      };
    }
    return {
      ctx: {
        organizationId: ORG,
        channelId: CHANNEL_ID,
        capabilities: {},
        tokenId: null,
      },
      errorResponse: null,
    };
  }),
}));

const SCHEMA = `
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    document_id text,
    whatsapp text,
    email text,
    address text,
    notes text,
    marketing_opt_in boolean DEFAULT true NOT NULL,
    total_spent numeric(14, 2) DEFAULT '0' NOT NULL,
    last_purchase_at timestamp,
    created_by text,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  // Seed own-org customers
  await pg.query(
    `INSERT INTO customers (id, organization_id, name, whatsapp, document_id, email)
     VALUES
       ('cccccccc-1111-4111-8111-000000000001', $1, 'Ana Gomez', '3001111111', '123456789', 'ana@test.com'),
       ('cccccccc-2222-4222-8222-000000000002', $1, 'Luis Perez', '3002222222', '987654321', 'luis@test.com')`,
    [ORG],
  );

  // Seed a customer from another org (must never appear in responses)
  await pg.query(
    `INSERT INTO customers (id, organization_id, name)
     VALUES ('cccccccc-9999-4999-8999-000000000009', 'org_other', 'Other Org Customer')`,
  );
});

beforeEach(() => {
  h.authed = true;
  vi.clearAllMocks();
});

function getRequest(params: Record<string, string> = {}): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/agent/customers${qs ? `?${qs}` : ''}`, {
    headers: { authorization: 'Bearer test' },
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/customers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/agent/customers', () => {
  it('returns only org customers — cross-org customer excluded', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest());

    expect(res.status).toBe(200);

    const data = await res.json();

    // Must include our two org customers
    expect(data.items).toHaveLength(2);

    // Must NOT include the other-org customer
    const names = data.items.map((c: { name: string }) => c.name);

    expect(names).not.toContain('Other Org Customer');
    expect(names).toContain('Ana Gomez');
    expect(names).toContain('Luis Perez');
  });

  it('search by name filters results', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ search: 'ana' }));

    expect(res.status).toBe(200);

    const data = await res.json();

    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe('Ana Gomez');
  });

  it('search by whatsapp number returns matching customer', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ search: '3002222222' }));

    expect(res.status).toBe(200);

    const data = await res.json();

    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe('Luis Perez');
  });

  it('no auth → 401', async () => {
    h.authed = false;
    const { GET } = await import('./route');
    const res = await GET(getRequest());

    expect(res.status).toBe(401);
  });
});

describe('POST /api/agent/customers', () => {
  it('creates a customer and returns the created row', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        name: 'Carlos Test',
        whatsapp: '3003333333',
        email: 'carlos@test.com',
      }),
    );

    expect(res.status).toBe(201);

    const created = await res.json();

    expect(created.name).toBe('Carlos Test');
    expect(created.whatsapp).toBe('3003333333');
    expect(created.organizationId).toBe(ORG);
  });

  it('missing name → 400', async () => {
    const { POST } = await import('./route');
    const res = await POST(postRequest({ whatsapp: '3009999999' }));

    expect(res.status).toBe(400);
  });

  it('no auth → 401', async () => {
    h.authed = false;
    const { POST } = await import('./route');
    const res = await POST(postRequest({ name: 'Test' }));

    expect(res.status).toBe(401);
  });
});
