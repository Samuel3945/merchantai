/**
 * POST /api/agent/conversations/upsert
 *
 * Idempotent upsert by (organizationId, channelId, remoteJid).
 * n8n reads botPaused + botPausedUntil from the response to decide
 * whether to respond on this conversation.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_upsert_test';
const CHANNEL_ID = 'aaaabbbb-0001-0001-0001-ccccddddeeee';
const TOKEN_ID = 'aaaabbbb-0002-0002-0002-ccccddddeeee';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: {
    organizationId: 'org_upsert_test',
    channelId: 'aaaabbbb-0001-0001-0001-ccccddddeeee',
    capabilities: { orders: true, products_lookup: true },
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
    blocked boolean DEFAULT false NOT NULL,
    last_message_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    UNIQUE (organization_id, channel_id, remote_jid)
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM conversations');
  h.authCtx = {
    organizationId: ORG,
    channelId: CHANNEL_ID,
    capabilities: { orders: true, products_lookup: true },
    tokenId: TOKEN_ID,
  };
  vi.clearAllMocks();
});

function upsertRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/conversations/upsert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/agent/conversations/upsert', () => {
  it('first upsert → row created with status=active, botPaused=false', async () => {
    const { POST } = await import('./route');
    const res = await POST(upsertRequest({ remoteJid: '5730012345@s.whatsapp.net' }));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.id).toBeTruthy();
    expect(body.status).toBe('active');
    expect(body.botPaused).toBe(false);
    expect(body.botPausedUntil).toBeNull();
  });

  it('second upsert same (org, channel, jid) → same id returned, no duplicate row', async () => {
    const { POST } = await import('./route');
    const payload = { remoteJid: '5730099999@s.whatsapp.net' };

    const first = await (await POST(upsertRequest(payload))).json();
    const second = await (await POST(upsertRequest(payload))).json();

    expect(second.id).toBe(first.id);

    const rows = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM conversations WHERE remote_jid = $1`,
      ['5730099999@s.whatsapp.net'],
    );

    expect(rows.rows[0]!.count).toBe('1');
  });

  it('response includes botPaused + botPausedUntil (n8n reads these)', async () => {
    // Seed a conversation that is already paused
    await pg.query(
      `INSERT INTO conversations (organization_id, channel_id, remote_jid, bot_paused, bot_paused_until)
       VALUES ($1, $2, $3, true, '2099-01-01 00:00:00')`,
      [ORG, CHANNEL_ID, '5730011111@s.whatsapp.net'],
    );

    const { POST } = await import('./route');
    const res = await POST(upsertRequest({ remoteJid: '5730011111@s.whatsapp.net' }));
    const body = await res.json();

    expect(body.botPaused).toBe(true);
    expect(body.botPausedUntil).not.toBeNull();
  });

  it('auto-resume: an elapsed pause reactivates the bot on this inbound message', async () => {
    // Seed a paused conversation whose pause window is already in the past.
    await pg.query(
      `INSERT INTO conversations (organization_id, channel_id, remote_jid, bot_paused, bot_paused_until, bot_paused_by, attended_by)
       VALUES ($1, $2, $3, true, '2000-01-01 00:00:00', 'user_123', 'user_123')`,
      [ORG, CHANNEL_ID, '5730022222@s.whatsapp.net'],
    );

    const { POST } = await import('./route');
    const res = await POST(upsertRequest({ remoteJid: '5730022222@s.whatsapp.net' }));
    const body = await res.json();

    // Response reports the resumed state so n8n answers on this same turn.
    expect(body.botPaused).toBe(false);
    expect(body.botPausedUntil).toBeNull();
    expect(body.attendedBy).toBe('bot');

    // And the pause was persisted as cleared.
    const rows = await pg.query<{
      bot_paused: boolean;
      bot_paused_until: string | null;
      attended_by: string;
    }>(
      `SELECT bot_paused, bot_paused_until, attended_by FROM conversations WHERE remote_jid = $1`,
      ['5730022222@s.whatsapp.net'],
    );

    expect(rows.rows[0]!.bot_paused).toBe(false);
    expect(rows.rows[0]!.bot_paused_until).toBeNull();
    expect(rows.rows[0]!.attended_by).toBe('bot');
  });

  it('response includes blocked (n8n reads it to stay silent)', async () => {
    await pg.query(
      `INSERT INTO conversations (organization_id, channel_id, remote_jid, blocked)
       VALUES ($1, $2, $3, true)`,
      [ORG, CHANNEL_ID, '5730033333@s.whatsapp.net'],
    );

    const { POST } = await import('./route');
    const res = await POST(upsertRequest({ remoteJid: '5730033333@s.whatsapp.net' }));
    const body = await res.json();

    expect(body.blocked).toBe(true);

    // A brand-new conversation defaults to not blocked.
    const fresh = await POST(upsertRequest({ remoteJid: '5730044444@s.whatsapp.net' }));

    expect((await fresh.json()).blocked).toBe(false);
  });

  it('cross-org body org → own org from token used', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      upsertRequest({ remoteJid: '5730077777@s.whatsapp.net', organizationId: 'org_other' }),
    );

    expect(res.status).toBe(200);

    const rows = await pg.query<{ organization_id: string }>(
      `SELECT organization_id FROM conversations WHERE remote_jid = $1`,
      ['5730077777@s.whatsapp.net'],
    );

    expect(rows.rows[0]!.organization_id).toBe(ORG);
  });
});
