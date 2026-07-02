'use server';

import { auth } from '@clerk/nextjs/server';
import { asc, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/db-context';
import { sendWhatsAppTextForOrg } from '@/libs/delivery-whatsapp';
import { conversationsSchema, customersSchema, messagesSchema } from '@/models/Schema';
import { PAUSE_MINUTES } from './status';

// Owner/admin controls for the WhatsApp Conversaciones inbox. These are DASHBOARD
// actions: Clerk-authed and org-scoped via db.forOrg — deliberately NOT the
// agent-token endpoints under /api/agent (those are for n8n). A cross-org id
// returns an empty update → treated as "not found".

async function requireOwnerOrg(): Promise<{ userId: string; orgId: string }> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  // Mirrors the ai-agent page: the owner (no role) or an org admin may manage
  // conversations; other members are bounced.
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Solo un administrador puede gestionar las conversaciones');
  }
  return { userId, orgId };
}

export type ConversationRow = {
  id: string;
  remoteJid: string;
  customerName: string | null;
  status: string;
  botPaused: boolean;
  botPausedUntil: string | null;
  attendedBy: string;
  blocked: boolean;
  lastMessageAt: string | null;
  updatedAt: string;
};

// The subset of fields the inbox actions mutate. The client merges this back
// into the existing row so it keeps the joined customerName.
export type ConversationControlPatch = Pick<
  ConversationRow,
  'id' | 'status' | 'botPaused' | 'botPausedUntil' | 'attendedBy' | 'blocked' | 'updatedAt'
>;

type ConversationSelect = typeof conversationsSchema.$inferSelect;

function toPatch(row: ConversationSelect): ConversationControlPatch {
  return {
    id: row.id,
    status: row.status,
    botPaused: row.botPaused,
    botPausedUntil: row.botPausedUntil ? row.botPausedUntil.toISOString() : null,
    attendedBy: row.attendedBy,
    blocked: row.blocked,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All conversations for the active org, most recent activity first. */
export async function listConversations(): Promise<ConversationRow[]> {
  const { orgId } = await requireOwnerOrg();

  const rows = await db
    .forOrg(orgId)
    .select({
      id: conversationsSchema.id,
      remoteJid: conversationsSchema.remoteJid,
      status: conversationsSchema.status,
      botPaused: conversationsSchema.botPaused,
      botPausedUntil: conversationsSchema.botPausedUntil,
      attendedBy: conversationsSchema.attendedBy,
      blocked: conversationsSchema.blocked,
      lastMessageAt: conversationsSchema.lastMessageAt,
      updatedAt: conversationsSchema.updatedAt,
      customerName: customersSchema.name,
    })
    .from(conversationsSchema)
    .leftJoin(
      customersSchema,
      eq(customersSchema.id, conversationsSchema.customerId),
    )
    .orderBy(desc(conversationsSchema.lastMessageAt))
    .limit(200);

  return rows.map(r => ({
    id: r.id,
    remoteJid: r.remoteJid,
    customerName: r.customerName ?? null,
    status: r.status,
    botPaused: r.botPaused,
    botPausedUntil: r.botPausedUntil ? r.botPausedUntil.toISOString() : null,
    attendedBy: r.attendedBy,
    blocked: r.blocked,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function updateConversation(
  orgId: string,
  id: string,
  patch: Partial<ConversationSelect>,
): Promise<ConversationControlPatch> {
  const [updated] = await db
    .forOrg(orgId)
    .update(conversationsSchema)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(conversationsSchema.id, id))
    .returning();
  if (!updated) {
    throw new Error('Conversación no encontrada');
  }
  return toPatch(updated);
}

// The takeover patch shared by "Atender yo" (pauseConversationBot) and the
// implicit takeover that happens when the operator sends a manual reply
// (sendConversationMessage): pause the bot for PAUSE_MINUTES and stamp who took
// over. The bot auto-resumes on the next inbound message once the window lapses,
// or immediately when the operator clicks "Conversación finalizada".
function takeoverPatch(userId: string): Partial<ConversationSelect> {
  return {
    botPaused: true,
    botPausedUntil: new Date(Date.now() + PAUSE_MINUTES * 60_000),
    botPausedBy: userId,
    attendedBy: userId,
  };
}

/**
 * "Atender yo": take over the conversation WITHOUT sending a message yet. Pauses
 * the bot for PAUSE_MINUTES and records who took over, so the conversation is
 * never stuck silent.
 */
export async function pauseConversationBot(
  id: string,
): Promise<ConversationControlPatch> {
  const { userId, orgId } = await requireOwnerOrg();
  return updateConversation(orgId, id, takeoverPatch(userId));
}

/** "Reactivar bot ahora": hand the conversation back to the bot immediately. */
export async function resumeConversationBot(
  id: string,
): Promise<ConversationControlPatch> {
  const { orgId } = await requireOwnerOrg();
  return updateConversation(orgId, id, {
    botPaused: false,
    botPausedUntil: null,
    botPausedBy: null,
    attendedBy: 'bot',
  });
}

/** Block / unblock a number. Blocked → the bot stays silent even when active. */
export async function setConversationBlocked(
  id: string,
  blocked: boolean,
): Promise<ConversationControlPatch> {
  const { orgId } = await requireOwnerOrg();
  return updateConversation(orgId, id, { blocked });
}

// ─── Thread (inbox detail pane) ─────────────────────────────────────────
// Message history + manual reply for the master/detail inbox UI. These reuse
// the SAME `messages` table n8n writes to via /api/agent/conversations/:id/
// messages, but that route is agent-token-authed (for n8n), not callable from
// the dashboard's Clerk session — so the dashboard gets its own Clerk-authed,
// org-scoped actions here instead of hitting the API route.

export type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'bot' | 'human';
  body: string | null;
  contentType: string;
  createdAt: string;
};

// sendConversationMessage returns BOTH the appended message and the conversation
// control patch produced by the implicit takeover (auto-pause), so the client can
// append the bubble AND update the row's badge/countdown in one round-trip.
export type SendMessageResult = {
  message: MessageRow;
  conversation: ConversationControlPatch;
};

const THREAD_LIMIT = 100;

async function requireOwnedConversation(
  orgId: string,
  conversationId: string,
): Promise<{ id: string; remoteJid: string }> {
  const [conv] = await db
    .forOrg(orgId)
    .select({ id: conversationsSchema.id, remoteJid: conversationsSchema.remoteJid })
    .from(conversationsSchema)
    .where(eq(conversationsSchema.id, conversationId))
    .limit(1);
  if (!conv) {
    throw new Error('Conversación no encontrada');
  }
  return conv;
}

/** Full message thread for one conversation, oldest first (for the thread pane). */
export async function listConversationMessages(
  conversationId: string,
): Promise<MessageRow[]> {
  const { orgId } = await requireOwnerOrg();
  await requireOwnedConversation(orgId, conversationId);

  const rows = await db
    .forOrg(orgId)
    .select({
      id: messagesSchema.id,
      direction: messagesSchema.direction,
      senderType: messagesSchema.senderType,
      body: messagesSchema.body,
      contentType: messagesSchema.contentType,
      createdAt: messagesSchema.createdAt,
    })
    .from(messagesSchema)
    .where(eq(messagesSchema.conversationId, conversationId))
    .orderBy(asc(messagesSchema.createdAt))
    .limit(THREAD_LIMIT);

  return rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * "Respondé vos": sends a free-text WhatsApp message through the org's own
 * connected channel — the SAME sendWhatsAppTextForOrg path the delivery
 * feature's "Pedir aclaración de dirección" button uses — records it on the
 * thread as an outbound/human message, AND implicitly takes over from the bot.
 *
 * The takeover is the SAME one "Atender yo" performs (takeoverPatch): the first
 * reply pauses the bot for PAUSE_MINUTES and stamps the operator as attendedBy,
 * so nobody has to click "Atender yo" separately. The bot comes back either when
 * the operator clicks "Conversación finalizada" (resumeConversationBot) or when
 * the 30-min window lapses on the next inbound message — whichever is first.
 */
export async function sendConversationMessage(
  conversationId: string,
  body: string,
): Promise<SendMessageResult> {
  const { userId, orgId } = await requireOwnerOrg();
  const text = body.trim();
  if (!text) {
    throw new Error('Escribí un mensaje para enviar');
  }

  const conv = await requireOwnedConversation(orgId, conversationId);
  // remoteJid looks like "5730012345@s.whatsapp.net"; sendWhatsAppTextForOrg
  // strips non-digits anyway, but this avoids sending the "@s.whatsapp.net"
  // suffix through as part of the number.
  const phone = conv.remoteJid.split('@')[0] ?? conv.remoteJid;

  const result = await sendWhatsAppTextForOrg(orgId, phone, text);
  if (!result.sent) {
    throw new Error(
      result.skipped && result.reason === 'no_connected_channel'
        ? 'Conectá un WhatsApp del negocio para enviar mensajes.'
        : result.skipped
          ? 'WhatsApp no está configurado.'
          : 'No se pudo enviar el mensaje. Intentá de nuevo.',
    );
  }

  const [inserted] = await db
    .forOrg(orgId)
    .insert(messagesSchema)
    .values({
      conversationId,
      direction: 'outbound',
      senderType: 'human',
      senderId: userId,
      contentType: 'text',
      body: text,
    })
    .returning({
      id: messagesSchema.id,
      direction: messagesSchema.direction,
      senderType: messagesSchema.senderType,
      body: messagesSchema.body,
      contentType: messagesSchema.contentType,
      createdAt: messagesSchema.createdAt,
    });

  if (!inserted) {
    throw new Error('El mensaje se envió pero no se pudo guardar en el historial');
  }

  // Auto-pause on first reply: fold the takeover into the same update that
  // stamps lastMessageAt, so a manual reply always implies a human takeover.
  // updateConversation adds updatedAt and returns the control patch the client
  // merges into the row (badge → "Atendiendo vos", the countdown starts).
  const conversation = await updateConversation(orgId, conversationId, {
    ...takeoverPatch(userId),
    lastMessageAt: new Date(),
  });

  return {
    message: {
      id: inserted.id,
      direction: inserted.direction,
      senderType: inserted.senderType,
      body: inserted.body,
      contentType: inserted.contentType,
      createdAt: inserted.createdAt.toISOString(),
    },
    conversation,
  };
}
