/**
 * POST /api/agent/conversations/upsert
 *
 * Idempotent conversation upsert keyed on (organizationId, channelId, remoteJid).
 * A second call with the same triple returns the existing row without creating a
 * duplicate — race-safe via the unique index + onConflictDoUpdate.
 *
 * n8n reads botPaused + botPausedUntil from the response to decide whether the
 * bot should respond on this conversation. Enforcement of silence lives in n8n;
 * the server just persists and reports state.
 *
 * Body values for organizationId or channelId are IGNORED — the agent token is
 * the exclusive identity source (spec §Conversation Upsert).
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { conversationsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  remoteJid: z.string().trim().min(1),
});

export async function POST(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { organizationId, channelId } = ctx;
  const { remoteJid } = body;
  const now = new Date();

  const [row] = await db
    .forOrg(organizationId)
    .insert(conversationsSchema)
    .values({
      organizationId,
      channelId,
      remoteJid,
      status: 'active',
      botPaused: false,
      lastMessageAt: now,
    })
    .onConflictDoUpdate({
      target: [
        conversationsSchema.organizationId,
        conversationsSchema.channelId,
        conversationsSchema.remoteJid,
      ],
      set: {
        lastMessageAt: now,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) {
    return NextResponse.json({ error: 'Upsert failed' }, { status: 500 });
  }

  // The tenant-db insert proxy widens the returned row type; the row is a full
  // conversations record, so re-narrow it to the schema select type.
  const convo = row as typeof conversationsSchema.$inferSelect;

  // AUTO-RESUME (the guarantee): a conversation whose pause window has already
  // elapsed reactivates the bot on THIS very inbound message, so a handoff is
  // never left silent forever. We clear the pause and hand it back to the bot,
  // then report the resumed state so n8n answers on this same turn.
  let { botPaused, botPausedUntil, attendedBy } = convo;
  if (botPaused && botPausedUntil && botPausedUntil.getTime() <= now.getTime()) {
    await db
      .forOrg(organizationId)
      .update(conversationsSchema)
      .set({
        botPaused: false,
        botPausedUntil: null,
        botPausedBy: null,
        attendedBy: 'bot',
        updatedAt: now,
      })
      .where(eq(conversationsSchema.id, convo.id));
    botPaused = false;
    botPausedUntil = null;
    attendedBy = 'bot';
  }

  return NextResponse.json({
    id: convo.id,
    status: convo.status,
    botPaused,
    botPausedUntil: botPausedUntil ?? null,
    blocked: convo.blocked,
    attendedBy,
    lastMessageAt: convo.lastMessageAt ?? null,
  });
}
