/**
 * GET  /api/agent/customers?search=   — search org customers by name/whatsapp/doc/email
 * POST /api/agent/customers            — create a customer in the org
 *
 * Both endpoints are agent-auth gated (Bearer token or N8N_SERVICE_SECRET + X-Agent-Channel).
 * No capability gate is required — customer lookup and creation are always available
 * to authenticated agents. Tenant isolation is enforced via db.forOrg (never raw DB).
 */
import { and, eq, ilike, or } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { customersSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

type AgentCustomerBody = {
  name?: string;
  whatsapp?: string | null;
  phone?: string | null;
  documentId?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
};

export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse as NextResponse;
  }

  const tdb = db.forOrg(ctx.organizationId);
  const search = new URL(req.url).searchParams.get('search')?.trim() || '';
  const like = `%${search}%`;

  const where = search
    ? and(
        eq(customersSchema.deleted, false),
        or(
          ilike(customersSchema.name, like),
          ilike(customersSchema.whatsapp, like),
          ilike(customersSchema.documentId, like),
          ilike(customersSchema.email, like),
        ),
      )
    : eq(customersSchema.deleted, false);

  const rows = await tdb
    .select({
      id: customersSchema.id,
      organization_id: customersSchema.organizationId,
      name: customersSchema.name,
      document_id: customersSchema.documentId,
      whatsapp: customersSchema.whatsapp,
      email: customersSchema.email,
      address: customersSchema.address,
      notes: customersSchema.notes,
    })
    .from(customersSchema)
    .where(where)
    .orderBy(customersSchema.name)
    .limit(100);

  return NextResponse.json({ items: rows });
}

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse as NextResponse;
  }

  let body: AgentCustomerBody;
  try {
    body = (await req.json()) as AgentCustomerBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const name = (body.name || '').trim();
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const tdb = db.forOrg(ctx.organizationId);

  try {
    const [created] = await tdb
      .insert(customersSchema)
      .values({
        name,
        whatsapp: body.whatsapp ?? body.phone ?? null,
        documentId: body.documentId ?? null,
        email: body.email ?? null,
        address: body.address ?? null,
        notes: body.notes ?? null,
        createdBy: ctx.tokenId ?? ctx.channelId,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error creating customer' },
      { status: 400 },
    );
  }
}
