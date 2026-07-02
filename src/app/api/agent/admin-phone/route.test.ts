/**
 * GET /api/agent/admin-phone
 *
 * Returns the org's `business_phone` app setting plus its last-10-digit
 * normalization. n8n reads `adminPhoneDigits` to decide isAdmin against the
 * caller's remoteJid.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_admin_phone_test';
const CHANNEL_ID = 'aaaabbbb-0001-0001-0001-ccccddddeeee';
const TOKEN_ID = 'aaaabbbb-0002-0002-0002-ccccddddeeee';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: {
    organizationId: 'org_admin_phone_test',
    channelId: 'aaaabbbb-0001-0001-0001-ccccddddeeee',
    capabilities: {} as Record<string, boolean>,
    tokenId: 'aaaabbbb-0002-0002-0002-ccccddddeeee',
  } as {
    organizationId: string;
    channelId: string;
    capabilities: Record<string, boolean>;
    tokenId: string;
  } | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/agent-auth', () => ({
  requireAgentAuth: vi.fn(async () =>
    h.authCtx
      ? { ctx: h.authCtx, errorResponse: null }
      : { ctx: null, errorResponse: new Response('{"error":"Unauthorized"}', { status: 401 }) },
  ),
}));

const SCHEMA = `
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM app_settings');
  h.authCtx = {
    organizationId: ORG,
    channelId: CHANNEL_ID,
    capabilities: {},
    tokenId: TOKEN_ID,
  };
  vi.clearAllMocks();
});

function adminPhoneRequest(): Request {
  return new Request('http://localhost/api/agent/admin-phone', {
    method: 'GET',
    headers: { authorization: 'Bearer test' },
  });
}

async function seedPhone(value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, 'business_phone', $2)`,
    [ORG, value],
  );
}

describe('GET /api/agent/admin-phone', () => {
  it('no business_phone set → empty strings (nobody matches as admin)', async () => {
    const { GET } = await import('./route');
    const res = await GET(adminPhoneRequest());

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.adminPhone).toBe('');
    expect(body.adminPhoneDigits).toBe('');
  });

  it('formatted number → raw preserved, digits normalized to last 10', async () => {
    await seedPhone('+57 300 123 4567');

    const { GET } = await import('./route');
    const body = await (await GET(adminPhoneRequest())).json();

    expect(body.adminPhone).toBe('+57 300 123 4567');
    expect(body.adminPhoneDigits).toBe('3001234567');
  });

  it('plain 10-digit number → digits equal the number', async () => {
    await seedPhone('3001234567');

    const { GET } = await import('./route');
    const body = await (await GET(adminPhoneRequest())).json();

    expect(body.adminPhoneDigits).toBe('3001234567');
  });

  it('dashes and spaces → stripped', async () => {
    await seedPhone('300-123-4567');

    const { GET } = await import('./route');
    const body = await (await GET(adminPhoneRequest())).json();

    expect(body.adminPhoneDigits).toBe('3001234567');
  });

  it('is org-scoped: another org\'s phone is not returned', async () => {
    await pg.query(
      `INSERT INTO app_settings (organization_id, key, value) VALUES ('other_org', 'business_phone', '3009999999')`,
    );

    const { GET } = await import('./route');
    const body = await (await GET(adminPhoneRequest())).json();

    expect(body.adminPhone).toBe('');
  });
});
