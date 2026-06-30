/**
 * PATCH /api/agent/conversations/:id/bot-control
 *
 * Manages conversation bot-control state: pause, resume, handoff.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_bot_control_test';
const CHANNEL_ID = 'bbbbcccc-0001-0001-0001-ddddeeee0001';
const TOKEN_ID = 'bbbbcccc-0002-0002-0002-ddddeeee0002';
const CONV_ID = 'bbbbcccc-0003-0003-0003-ddddeeee0003';
const CONV_ID_OTHER_ORG = 'bbbbcccc-0004-0004-0004-ddddeeee0004';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: {
    organizationId: 'org_bot_control_test',
    channelId: 'bbbbcccc-0001-0001-0001-ddddeeee0001',
    capabilities: { orders: true },
    tokenId: 'bbbbcccc-0002-0002-0002-ddddeeee0002',
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
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
  // Seed conversations
  await pg.query(
    `INSERT INTO conversations (id, organization_id, channel_id, remote_jid)
     VALUES ($1, $2, $3, '573001@s.whatsapp.net')`,
    [CONV_ID, ORG, CHANNEL_ID],
  );
  await pg.query(
    `INSERT INTO conversations (id, organization_id, channel_id, remote_jid)
     VALUES ($1, $2, $3, '573002@s.whatsapp.net')`,
    [CONV_ID_OTHER_ORG, 'org_other', CHANNEL_ID],
  );
});

beforeEach(() => {
  h.authCtx = {
    organizationId: ORG,
    channelId: CHANNEL_ID,
    capabilities: { orders: true },
    tokenId: TOKEN_ID,
  };
  vi.clearAllMocks();
});

function botControlRequest(convId: string, body: unknown): Request {
  return new Request(`http://localhost/api/agent/conversations/${convId}/bot-control`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

async function getConv(id: string) {
  const result = await pg.query<{
    bot_paused: boolean;
    bot_paused_until: Date | null;
    status: string;
    attended_by: string;
  }>(
    `SELECT bot_paused, bot_paused_until, status, attended_by FROM conversations WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

describe('PATCH /api/agent/conversations/:id/bot-control', () => {
  beforeEach(async () => {
    // Reset conversation state
    await pg.query(
      `UPDATE conversations SET bot_paused = false, bot_paused_until = null, status = 'active', attended_by = 'bot' WHERE id = $1`,
      [CONV_ID],
    );
  });

  it('pause active → botPaused=true', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(botControlRequest(CONV_ID, { action: 'pause' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const conv = await getConv(CONV_ID);

    expect(conv!.bot_paused).toBe(true);
  });

  it('pause already-paused (idempotent) → succeeds, botPausedUntil updated if supplied', async () => {
    await pg.query(`UPDATE conversations SET bot_paused = true WHERE id = $1`, [CONV_ID]);
    const { PATCH } = await import('./route');
    const until = '2099-12-31T23:59:59.000Z';
    const res = await PATCH(botControlRequest(CONV_ID, { action: 'pause', botPausedUntil: until }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const conv = await getConv(CONV_ID);

    expect(conv!.bot_paused).toBe(true);
    expect(conv!.bot_paused_until).not.toBeNull();
  });

  it('resume → botPaused=false, botPausedUntil=null', async () => {
    await pg.query(
      `UPDATE conversations SET bot_paused = true, bot_paused_until = '2099-01-01' WHERE id = $1`,
      [CONV_ID],
    );
    const { PATCH } = await import('./route');
    const res = await PATCH(botControlRequest(CONV_ID, { action: 'resume' }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);

    const conv = await getConv(CONV_ID);

    expect(conv!.bot_paused).toBe(false);
    expect(conv!.bot_paused_until).toBeNull();
  });

  it('handoff → status=handoff, attendedBy set', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(
      botControlRequest(CONV_ID, { action: 'handoff', attendedBy: 'user_agent_123' }),
      { params: Promise.resolve({ id: CONV_ID }) },
    );

    expect(res.status).toBe(200);

    const conv = await getConv(CONV_ID);

    expect(conv!.status).toBe('handoff');
    expect(conv!.attended_by).toBe('user_agent_123');
  });

  it('cross-org conv id → 404', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(
      botControlRequest(CONV_ID_OTHER_ORG, { action: 'pause' }),
      { params: Promise.resolve({ id: CONV_ID_OTHER_ORG }) },
    );

    expect(res.status).toBe(404);
  });
});
