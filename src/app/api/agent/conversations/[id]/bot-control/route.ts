import { eq } from 'drizzle-orm';
/**
 * PATCH /api/agent/conversations/:id/bot-control
 *
 * Bot-control signal for a conversation: pause, resume, or handoff.
 * Scoped via db.forOrg so a cross-org conversation id returns 404 (empty update).
 *
 * Actions:
 *   pause   — set botPaused=true (idempotent; updates botPausedUntil if supplied)
 *   resume  — set botPaused=false, botPausedUntil=null
 *   handoff — set status=handoff, attendedBy=<userId>
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { conversationsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('pause'),
    botPausedUntil: z.string().datetime().optional(),
  }),
  z.object({ action: z.literal('resume') }),
  z.object({
    action: z.literal('handoff'),
    attendedBy: z.string().min(1),
  }),
]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id: convId } = await params;
  const { organizationId } = ctx;
  const now = new Date();

  let patch: Record<string, unknown>;
  if (body.action === 'pause') {
    patch = {
      botPaused: true,
      botPausedUntil: body.botPausedUntil ? new Date(body.botPausedUntil) : undefined,
      updatedAt: now,
    };
  } else if (body.action === 'resume') {
    patch = { botPaused: false, botPausedUntil: null, updatedAt: now };
  } else {
    patch = { status: 'handoff', attendedBy: body.attendedBy, updatedAt: now };
  }

  const updated = await db
    .forOrg(organizationId)
    .update(conversationsSchema)
    .set(patch as never)
    .where(eq(conversationsSchema.id, convId))
    .returning({ id: conversationsSchema.id });

  if (!updated.length) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: convId, action: body.action });
}
