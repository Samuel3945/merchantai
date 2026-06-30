/**
 * agent-auth: requireAgentAuth unit tests.
 *
 * Uses PGlite + hand-written DDL (drizzle migrations don't run in tests).
 * Mocks @/libs/DB so both the direct raw-db lookup in agent-auth.ts AND the
 * db.forOrg proxy in db-context.ts use the same in-memory database.
 * Mocks @/libs/Env to control N8N_SERVICE_SECRET per test.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  serviceSecret: undefined as string | undefined,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/Env', () => ({
  get Env() {
    return { N8N_SERVICE_SECRET: h.serviceSecret };
  },
}));

const SCHEMA = `
  CREATE TABLE whatsapp_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    instance_name text NOT NULL,
    label text,
    purpose text,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'connecting' NOT NULL,
    phone_number text,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE agent_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    channel_id uuid,
    token uuid NOT NULL DEFAULT gen_random_uuid(),
    description text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    expires_at timestamp,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org_agent_auth_test';
const CHANNEL_ID = '11111111-1111-1111-1111-111111111111';
const TOKEN_VAL = '22222222-2222-2222-2222-222222222222';
const TOKEN_ID = '33333333-3333-3333-3333-333333333333';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  // Seed the channel
  await pg.query(
    `INSERT INTO whatsapp_channels (id, organization_id, instance_name, created_by, capabilities)
     VALUES ($1, $2, 'inst1', 'user1', '{"orders":true,"products_lookup":true}')`,
    [CHANNEL_ID, ORG],
  );
});

beforeEach(async () => {
  await pg.exec('DELETE FROM agent_tokens');
  h.serviceSecret = undefined;
});

async function seedToken(overrides: {
  id?: string;
  token?: string;
  active?: boolean;
  expiresAt?: string | null;
  channelId?: string | null;
} = {}): Promise<void> {
  const {
    id = TOKEN_ID,
    token = TOKEN_VAL,
    active = true,
    expiresAt = null,
    channelId = CHANNEL_ID,
  } = overrides;

  await pg.query(
    `INSERT INTO agent_tokens (id, organization_id, channel_id, token, description, active, expires_at, created_by)
     VALUES ($1, $2, $3, $4, 'auto', $5, $6, 'system')`,
    [id, ORG, channelId, token, active, expiresAt],
  );
}

function makeRequest(token: string): Request {
  return new Request('http://localhost/api/agent/test', {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('requireAgentAuth', () => {
  it('valid active token → returns AgentAuthContext with organizationId, channelId, capabilities, tokenId', async () => {
    await seedToken();
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    expect(result.errorResponse).toBeNull();
    expect(result.ctx).toMatchObject({
      organizationId: ORG,
      channelId: CHANNEL_ID,
      tokenId: TOKEN_ID,
    });
    expect(result.ctx?.capabilities).toMatchObject({ orders: true, products_lookup: true });
  });

  it('unknown token → 401', async () => {
    const { requireAgentAuth } = await import('./agent-auth');
    const unknownToken = 'aaaabbbb-0000-0000-0000-ccccddddeeee';

    const result = await requireAgentAuth(makeRequest(unknownToken));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('inactive token → 401', async () => {
    await seedToken({ active: false });
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('expired token (expiresAt in past) → 401', async () => {
    await seedToken({ expiresAt: '2000-01-01 00:00:00' });
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('null channelId on token → 401', async () => {
    await seedToken({ channelId: null });
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('body orgId has no effect — token org is always used', async () => {
    await seedToken();
    const { requireAgentAuth } = await import('./agent-auth');

    // Build a request that carries a different org in the body (would be ignored)
    const req = new Request('http://localhost/api/agent/test', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${TOKEN_VAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organizationId: 'org_other' }),
    });

    const result = await requireAgentAuth(req);

    expect(result.errorResponse).toBeNull();
    expect(result.ctx?.organizationId).toBe(ORG);
  });

  it('channel not found in DB → 401', async () => {
    // Token points to a non-existent channel
    const missingChannelId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await seedToken({ channelId: missingChannelId });
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });
});

// ─── Service-secret path ──────────────────────────────────────────────────────

const SERVICE_SECRET = 'n8n-test-service-secret-abc123';
const SERVICE_INSTANCE = 'inst1'; // seeded in beforeAll above

function makeServiceRequest(secret: string, instance?: string): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (instance !== undefined) {
    headers['x-agent-channel'] = instance;
  }
  return new Request('http://localhost/api/agent/test', { headers });
}

describe('requireAgentAuth — service-secret path', () => {
  it('valid secret + valid X-Agent-Channel → ctx with org/channelId/capabilities; tokenId is null', async () => {
    h.serviceSecret = SERVICE_SECRET;
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeServiceRequest(SERVICE_SECRET, SERVICE_INSTANCE));

    expect(result.errorResponse).toBeNull();
    expect(result.ctx).toMatchObject({
      organizationId: ORG,
      channelId: CHANNEL_ID,
      tokenId: null,
    });
    expect(result.ctx?.capabilities).toMatchObject({ orders: true });
  });

  it('valid secret + unknown instance name → 401', async () => {
    h.serviceSecret = SERVICE_SECRET;
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeServiceRequest(SERVICE_SECRET, 'nonexistent-instance'));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('valid secret + missing X-Agent-Channel header → 401', async () => {
    h.serviceSecret = SERVICE_SECRET;
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeServiceRequest(SERVICE_SECRET /* no instance */));

    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('secret unset → service path skipped; valid UUID token still works via token path', async () => {
    // h.serviceSecret is undefined (reset in beforeEach)
    await seedToken();
    const { requireAgentAuth } = await import('./agent-auth');

    const result = await requireAgentAuth(makeRequest(TOKEN_VAL));

    // Token path should succeed normally
    expect(result.errorResponse).toBeNull();
    expect(result.ctx?.tokenId).toBe(TOKEN_ID);
  });

  it('empty-string secret → service path NEVER taken even if bearer matches', async () => {
    h.serviceSecret = '';
    const { requireAgentAuth } = await import('./agent-auth');

    // Bearer value equals the (empty) secret — must not match
    const result = await requireAgentAuth(makeServiceRequest('', SERVICE_INSTANCE));

    // An empty bearer is not extracted by extractBearer (returns null), so it's 401
    expect(result.ctx).toBeNull();
    expect(result.errorResponse?.status).toBe(401);
  });
});
