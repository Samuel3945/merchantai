/**
 * POST /api/agent/conversations/:id/messages  — append message
 * GET  /api/agent/conversations/:id/messages  — list messages
 *
 * Key behaviors:
 *   - Both inbound and outbound stored with direction + senderType
 *   - externalId dedup: second message with same (org, externalId) → existing row
 *   - conv.lastMessageAt updated on append
 *   - GET limit clamped to 50 silently
 *   - Cross-org conv id → 404
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_messages_test';
const CHANNEL_ID = 'ccccdddd-0001-0001-0001-eeeeffff0001';
const CONV_ID = 'ccccdddd-0002-0002-0002-eeeeffff0002';
const CONV_OTHER_ORG_ID = 'ccccdddd-0003-0003-0003-eeeeffff0003';
const TOKEN_ID = 'ccccdddd-0004-0004-0004-eeeeffff0004';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: {
    organizationId: 'org_messages_test',
    channelId: 'ccccdddd-0001-0001-0001-eeeeffff0001',
    capabilities: { orders: true },
    tokenId: 'ccccdddd-0004-0004-0004-eeeeffff0004',
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
  CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    channel_id uuid NOT NULL,
    customer_id uuid,
    remote_jid text NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    bot_paused boolean DEFAULT false NOT NULL,
    bot_paused_until timestamp,
    bot_paused_by text,
    attended_by text DEFAULT 'bot' NOT NULL,
    last_message_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    UNIQUE (organization_id, channel_id, remote_jid)
  );

  CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    external_id text,
    direction text NOT NULL,
    sender_type text NOT NULL,
    sender_id text,
    content_type text DEFAULT 'text' NOT NULL,
    body text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX messages_org_external_unique_idx ON messages (organization_id, external_id)
    WHERE external_id IS NOT NULL;
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
  // Seed conversations
  await pg.query(
    `INSERT INTO conversations (id, organization_id, channel_id, remote_jid)
     VALUES ($1, $2, $3, '5730011@s.whatsapp.net')`,
    [CONV_ID, ORG, CHANNEL_ID],
  );
  await pg.query(
    `INSERT INTO conversations (id, organization_id, channel_id, remote_jid)
     VALUES ($1, 'org_other', $2, '5730022@s.whatsapp.net')`,
    [CONV_OTHER_ORG_ID, CHANNEL_ID],
  );
});

beforeEach(async () => {
  await pg.exec('DELETE FROM messages');
  await pg.query(
    `UPDATE conversations SET last_message_at = NULL WHERE id = $1`,
    [CONV_ID],
  );
  h.authCtx = {
    organizationId: ORG,
    channelId: CHANNEL_ID,
    capabilities: { orders: true },
    tokenId: TOKEN_ID,
  };
  vi.clearAllMocks();
});

function postRequest(convId: string, body: unknown): Request {
  return new Request(`http://localhost/api/agent/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

function getRequest(convId: string, params: Record<string, string> = {}): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(
    `http://localhost/api/agent/conversations/${convId}/messages${qs ? `?${qs}` : ''}`,
    { headers: { authorization: 'Bearer test' } },
  );
}

describe('POST /api/agent/conversations/:id/messages', () => {
  it('append inbound → row with direction=inbound, senderType=customer; conv.lastMessageAt updated', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest(CONV_ID, {
        direction: 'inbound',
        senderType: 'customer',
        body: 'Hola',
        externalId: 'ext-001',
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    );

    expect(res.status).toBe(200);

    const msg = await res.json();

    expect(msg.direction).toBe('inbound');
    expect(msg.senderType).toBe('customer');

    // conv.lastMessageAt updated
    const conv = await pg.query<{ last_message_at: Date | null }>(
      `SELECT last_message_at FROM conversations WHERE id = $1`,
      [CONV_ID],
    );

    expect(conv.rows[0]!.last_message_at).not.toBeNull();
  });

  it('append outbound → row with direction=outbound, senderType=bot', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest(CONV_ID, { direction: 'outbound', senderType: 'bot', body: 'Claro!' }),
      { params: Promise.resolve({ id: CONV_ID }) },
    );

    expect(res.status).toBe(200);

    const msg = await res.json();

    expect(msg.direction).toBe('outbound');
    expect(msg.senderType).toBe('bot');
  });

  it('duplicate externalId → no new row, returns existing (spec: return existing)', async () => {
    const { POST } = await import('./route');
    const payload = { direction: 'inbound', senderType: 'customer', body: 'Dup', externalId: 'ext-dup-1' };
    const first = await (await POST(postRequest(CONV_ID, payload), { params: Promise.resolve({ id: CONV_ID }) })).json();
    const second = await (await POST(postRequest(CONV_ID, payload), { params: Promise.resolve({ id: CONV_ID }) })).json();

    expect(second.id).toBe(first.id);

    const rows = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM messages WHERE external_id = 'ext-dup-1'`,
    );

    expect(rows.rows[0]!.count).toBe('1');
  });

  it('cross-org conv id → 404', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest(CONV_OTHER_ORG_ID, { direction: 'inbound', senderType: 'customer', body: 'x' }),
      { params: Promise.resolve({ id: CONV_OTHER_ORG_ID }) },
    );

    expect(res.status).toBe(404);
  });
});

describe('GET /api/agent/conversations/:id/messages', () => {
  beforeEach(async () => {
    // Seed 20 messages
    for (let i = 0; i < 20; i++) {
      await pg.query(
        `INSERT INTO messages (organization_id, conversation_id, direction, sender_type, body, created_at)
         VALUES ($1, $2, 'inbound', 'customer', $3, NOW() + ($4 || ' seconds')::interval)`,
        [ORG, CONV_ID, `msg-${i}`, i],
      );
    }
  });

  it('GET limit=10 with 20 msgs → 10 rows newest first', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest(CONV_ID, { limit: '10' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const msgs = await res.json();

    expect(msgs).toHaveLength(10);
    // Newest first: msg-19 should be first
    expect(msgs[0].body).toBe('msg-19');
  });

  it('GET limit=200 (cap=50) → clamped to exactly 50, no error', async () => {
    // Add 40 more messages to reach 60 total (exceeds the 50 cap)
    for (let i = 20; i < 60; i++) {
      await pg.query(
        `INSERT INTO messages (organization_id, conversation_id, direction, sender_type, body, created_at)
         VALUES ($1, $2, 'inbound', 'customer', $3, NOW() + ($4 || ' seconds')::interval)`,
        [ORG, CONV_ID, `msg-${i}`, i],
      );
    }

    const { GET } = await import('./route');
    const res = await GET(getRequest(CONV_ID, { limit: '200' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const msgs = await res.json();

    expect(msgs.length).toBe(50);
  });

  it('GET limit=-5 → clamped to valid range, returns 200 with messages (no 500)', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest(CONV_ID, { limit: '-5' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const msgs = await res.json();

    // limit clamped to 1, so at most 1 message returned
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.length).toBeLessThanOrEqual(50);
  });

  it('GET limit=1.9 → floored to 1, returns 200 with 1 message (no 500)', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest(CONV_ID, { limit: '1.9' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const msgs = await res.json();

    expect(msgs.length).toBe(1);
  });
});
