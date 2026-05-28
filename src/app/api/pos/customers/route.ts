import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/db-context';
import { resolvePosAuth } from '@/libs/pos-auth';
import { customersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CustomerBody = {
  name?: string;
  client_name?: string;
  documentId?: string | null;
  document_id?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
};

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  const tdb = db.forPosAuth(ctx);
  const search = new URL(req.url).searchParams.get('search')?.trim() || '';
  const like = `%${search}%`;

  const where = search
    ? and(
        eq(customersSchema.deleted, false),
        or(
          ilike(customersSchema.name, like),
          ilike(customersSchema.documentId, like),
          ilike(customersSchema.whatsapp, like),
          ilike(customersSchema.email, like),
        ),
      )
    : eq(customersSchema.deleted, false);

  const rows = await tdb
    .select({
      id: customersSchema.id,
      name: customersSchema.name,
      document_id: customersSchema.documentId,
      whatsapp: customersSchema.whatsapp,
      email: customersSchema.email,
      address: customersSchema.address,
      notes: customersSchema.notes,
      total_spent: sql<string>`COALESCE(${customersSchema.totalSpent}, 0)`,
      last_purchase_at: customersSchema.lastPurchaseAt,
    })
    .from(customersSchema)
    .where(where)
    .orderBy(customersSchema.name)
    .limit(100);
  return NextResponse.json({ items: rows });
}

export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  let body: CustomerBody;
  try {
    body = (await req.json()) as CustomerBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const name = (body.name || body.client_name || '').trim();
  if (!name) {
    return NextResponse.json(
      { error: 'name es requerido' },
      { status: 400 },
    );
  }

  const tdb = db.forPosAuth(ctx);

  try {
    const [created] = await tdb
      .insert(customersSchema)
      .values({
        name,
        documentId: body.documentId ?? body.document_id ?? null,
        whatsapp: body.whatsapp ?? null,
        email: body.email ?? null,
        address: body.address ?? null,
        notes: body.notes ?? null,
        createdBy: ctx.cashierId,
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Error al crear cliente',
      },
      { status: 400 },
    );
  }
}
