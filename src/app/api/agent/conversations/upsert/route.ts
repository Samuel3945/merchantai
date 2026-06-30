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

  return NextResponse.json({
    id: row.id,
    status: row.status,
    botPaused: row.botPaused,
    botPausedUntil: row.botPausedUntil ?? null,
    attendedBy: row.attendedBy,
    lastMessageAt: row.lastMessageAt ?? null,
  });
}
