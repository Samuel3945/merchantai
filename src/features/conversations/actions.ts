'use server';

import { auth } from '@clerk/nextjs/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/libs/db-context';
import { conversationsSchema, customersSchema } from '@/models/Schema';
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

/**
 * "Atender yo": pause the bot for PAUSE_MINUTES and record who took over. The
 * bot auto-resumes on the next inbound message once the window lapses, so the
 * conversation is never stuck silent.
 */
export async function pauseConversationBot(
  id: string,
): Promise<ConversationControlPatch> {
  const { userId, orgId } = await requireOwnerOrg();
  const until = new Date(Date.now() + PAUSE_MINUTES * 60_000);
  return updateConversation(orgId, id, {
    botPaused: true,
    botPausedUntil: until,
    botPausedBy: userId,
    attendedBy: userId,
  });
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
