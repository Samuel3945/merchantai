/**
 * Token lifecycle tests for whatsapp-channels actions.
 *
 * Covers:
 *   - createWhatsAppChannel → auto-creates agent_tokens + paired pos_tokens
 *   - regenerateAgentToken  → deactivates old, inserts new
 *   - revokeAgentToken      → sets active=false; subsequent requireAgentAuth → 401
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentTokensSchema, conversationsSchema, messagesSchema, posTokensSchema, whatsappChannelsSchema } from '@/models/Schema';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgId: 'org_channel_test',
  userId: 'user_test_1',
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
    orgRole: 'org:admin',
  })),
}));

vi.mock('@/libs/evolution', () => ({
  buildInstanceName: () => `org_${h.orgId}__test`,
  createInstance: vi.fn(async () => ({ qrBase64: 'base64qr' })),
  deleteInstance: vi.fn(async () => {}),
  evolutionConfigured: () => true,
  fetchInstanceState: vi.fn(async () => ({ state: 'open', phoneNumber: null })),
  getQr: vi.fn(async () => ({ qrBase64: 'base64qr' })),
  setWebhook: vi.fn(async () => {}),
}));

vi.mock('@/libs/Logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@/libs/Env', () => ({
  Env: {
    WHATSAPP_N8N_WEBHOOK_URL: 'https://n8n.example.com/webhook/abc',
  },
}));

const SCHEMA = `
  CREATE TABLE whatsapp_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    instance_name text UNIQUE NOT NULL,
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

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    token uuid NOT NULL DEFAULT gen_random_uuid(),
    store_id text DEFAULT 'main' NOT NULL,
    device_name text NOT NULL,
    address_id uuid,
    created_by text NOT NULL,
    cashier_id uuid,
    current_cashier_id uuid,
    current_cashier_at timestamp,
    active boolean DEFAULT true NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    pin text DEFAULT '' NOT NULL,
    session_epoch integer DEFAULT 0 NOT NULL,
    last_sync_at timestamp,
    expires_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    default_sweep_destination_account_id uuid
  );

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
    updated_at timestamp DEFAULT now() NOT NULL
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
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM agent_tokens');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM whatsapp_channels');
  vi.clearAllMocks();
});

describe('createWhatsAppChannel — auto-creates agent_tokens + paired pos_tokens', () => {
  it('channel QR complete → agent_tokens row inserted + paired pos_tokens row (deviceName=ai_agent, pin="", allowOversell=false)', async () => {
    const { createWhatsAppChannel } = await import('./whatsapp-channels');
    const result = await createWhatsAppChannel({ label: 'Test' });

    expect(result.channel).toBeTruthy();
    expect(result.qrBase64).toBe('base64qr');

    const channelId = result.channel.id;

    // Verify agent_tokens row
    const agentTokens = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.channelId, channelId));

    expect(agentTokens).toHaveLength(1);
    expect(agentTokens[0]!.organizationId).toBe(h.orgId);
    expect(agentTokens[0]!.active).toBe(true);

    // Verify paired pos_tokens row
    const posTokens = await h.db
      .select()
      .from(posTokensSchema)
      .where(eq(posTokensSchema.organizationId, h.orgId));

    const aiToken = posTokens.find(t => t.deviceName === 'ai_agent');
    expect(aiToken).toBeTruthy();
    expect(aiToken!.pin).toBe('');
    expect(aiToken!.allowOversell).toBe(false);
  });
});

describe('regenerateAgentToken', () => {
  it('old row set to active=false, new row inserted', async () => {
    // Setup: create a channel + seed an agent token
    const { createWhatsAppChannel, regenerateAgentToken } = await import('./whatsapp-channels');
    const { channel } = await createWhatsAppChannel({});
    const channelId = channel.id;

    const [oldToken] = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.channelId, channelId));

    expect(oldToken).toBeTruthy();
    const oldId = oldToken!.id;
    const oldTokenVal = oldToken!.token;

    await regenerateAgentToken(channelId);

    // Old row must be inactive
    const [revoked] = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.id, oldId));
    expect(revoked!.active).toBe(false);

    // New row must be active with a different token value
    const tokens = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.channelId, channelId));
    const active = tokens.filter(t => t.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.token).not.toBe(oldTokenVal);
  });
});

describe('revokeAgentToken', () => {
  it('active=false after revoke', async () => {
    const { createWhatsAppChannel, revokeAgentToken } = await import('./whatsapp-channels');
    const { channel } = await createWhatsAppChannel({});

    const [tokenRow] = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.channelId, channel.id));

    expect(tokenRow!.active).toBe(true);

    await revokeAgentToken(tokenRow!.id);

    const [after] = await h.db
      .select()
      .from(agentTokensSchema)
      .where(eq(agentTokensSchema.id, tokenRow!.id));

    expect(after!.active).toBe(false);
  });
});

describe('deleteWhatsAppChannel', () => {
  it('channel with conversations and messages → all rows removed, no error thrown', async () => {
    const { createWhatsAppChannel, deleteWhatsAppChannel } = await import('./whatsapp-channels');
    const { channel } = await createWhatsAppChannel({ label: 'Delete Test' });
    const channelId = channel.id;

    // Seed a conversation and two messages for this channel.
    const convResult = await pg.query<{ id: string }>(
      `INSERT INTO conversations (organization_id, channel_id, remote_jid)
       VALUES ($1, $2, '5730099@s.whatsapp.net')
       RETURNING id`,
      [h.orgId, channelId],
    );
    const convId = convResult.rows[0]!.id;

    await pg.query(
      `INSERT INTO messages (organization_id, conversation_id, direction, sender_type, body)
       VALUES ($1, $2, 'inbound', 'customer', 'hello'),
              ($1, $2, 'outbound', 'bot', 'hi')`,
      [h.orgId, convId],
    );

    // Verify rows exist before delete.
    const convsBefore = await h.db
      .select({ id: conversationsSchema.id })
      .from(conversationsSchema)
      .where(eq(conversationsSchema.channelId, channelId));
    expect(convsBefore).toHaveLength(1);

    const msgsBefore = await h.db
      .select({ id: messagesSchema.id })
      .from(messagesSchema)
      .where(eq(messagesSchema.conversationId, convId));
    expect(msgsBefore).toHaveLength(2);

    // Delete the channel — must not throw.
    await expect(deleteWhatsAppChannel(channelId)).resolves.toBeUndefined();

    // Channel row must be gone.
    const channelAfter = await h.db
      .select({ id: whatsappChannelsSchema.id })
      .from(whatsappChannelsSchema)
      .where(eq(whatsappChannelsSchema.id, channelId));
    expect(channelAfter).toHaveLength(0);

    // Conversations cascaded away.
    const convsAfter = await h.db
      .select({ id: conversationsSchema.id })
      .from(conversationsSchema)
      .where(eq(conversationsSchema.channelId, channelId));
    expect(convsAfter).toHaveLength(0);

    // Messages cascaded away (via conversations FK ON DELETE CASCADE).
    const msgsAfter = await h.db
      .select({ id: messagesSchema.id })
      .from(messagesSchema)
      .where(eq(messagesSchema.conversationId, convId));
    expect(msgsAfter).toHaveLength(0);
  });
});
