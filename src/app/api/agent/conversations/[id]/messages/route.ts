/**
 * POST /api/agent/conversations/:id/messages  — append a message
 * GET  /api/agent/conversations/:id/messages  — list messages (newest first, capped at 50)
 *
 * Dedup: if externalId is supplied and a message with the same (organizationId, externalId)
 * already exists, the existing row is returned without creating a duplicate.
 * Conv ownership is verified via db.forOrg — a cross-org conv id yields 404.
 */
import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { conversationsSchema, messagesSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MESSAGE_LIMIT_CAP = 50;

const appendSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  senderType: z.enum(['customer', 'bot', 'human']),
  senderId: z.string().optional(),
  contentType: z.string().default('text'),
  body: z.string().optional(),
  externalId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: z.infer<typeof appendSchema>;
  try {
    body = appendSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { id: convId } = await params;
  const { organizationId } = ctx;

  // Verify conversation ownership via scoped db (cross-org → empty → 404).
  const [conv] = await db
    .forOrg(organizationId)
    .select({ id: conversationsSchema.id })
    .from(conversationsSchema)
    .where(eq(conversationsSchema.id, convId))
    .limit(1);

  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // Attempt insert with externalId partial-unique dedup.
  const [inserted] = await db
    .forOrg(organizationId)
    .insert(messagesSchema)
    .values({
      organizationId,
      conversationId: convId,
      externalId: body.externalId ?? null,
      direction: body.direction,
      senderType: body.senderType,
      senderId: body.senderId ?? null,
      contentType: body.contentType,
      body: body.body ?? null,
      metadata: (body.metadata as Record<string, unknown>) ?? {},
    })
    .onConflictDoNothing()
    .returning();

  let message = inserted;

  if (!message && body.externalId) {
    // onConflictDoNothing fired — re-select the existing row scoped to THIS
    // conversation so a reused externalId in a different conversation never
    // returns the wrong row (customers.ts:97 pattern).
    const [existing] = await db
      .forOrg(organizationId)
      .select()
      .from(messagesSchema)
      .where(
        and(
          eq(messagesSchema.conversationId, convId),
          eq(messagesSchema.externalId, body.externalId),
        ),
      )
      .limit(1);
    message = existing;
  }

  if (!message) {
    return NextResponse.json({ error: 'Failed to create message' }, { status: 500 });
  }

  // Update conv.lastMessageAt in the background (best-effort; scoped to org).
  await db
    .forOrg(organizationId)
    .update(conversationsSchema)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversationsSchema.id, convId));

  return NextResponse.json({
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    senderType: message.senderType,
    externalId: message.externalId ?? null,
    body: message.body ?? null,
    contentType: message.contentType,
    createdAt: message.createdAt,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const { id: convId } = await params;
  const { organizationId } = ctx;

  const url = new URL(req.url);
  const raw = Number(url.searchParams.get('limit'));
  const n = Number.isFinite(raw) ? Math.floor(raw) : 20;
  const limit = Math.min(Math.max(n, 1), MESSAGE_LIMIT_CAP);

  // Verify conversation ownership.
  const [conv] = await db
    .forOrg(organizationId)
    .select({ id: conversationsSchema.id })
    .from(conversationsSchema)
    .where(eq(conversationsSchema.id, convId))
    .limit(1);

  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const messages = await db
    .forOrg(organizationId)
    .select()
    .from(messagesSchema)
    .where(eq(messagesSchema.conversationId, convId))
    .orderBy(desc(messagesSchema.createdAt))
    .limit(limit);

  return NextResponse.json(
    messages.map(m => ({
      id: m.id,
      direction: m.direction,
      senderType: m.senderType,
      externalId: m.externalId ?? null,
      body: m.body ?? null,
      contentType: m.contentType,
      createdAt: m.createdAt,
    })),
  );
}
