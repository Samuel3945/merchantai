import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CustomerPatchBody = {
  name?: string | null;
  documentId?: string | null;
  document_id?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id es requerido' }, { status: 400 });
  }

  let body: CustomerPatchBody;
  try {
    body = (await req.json()) as CustomerPatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const name = body.name ?? null;
  const documentId = body.documentId ?? body.document_id ?? null;
  const whatsapp = body.whatsapp ?? null;
  const email = body.email ?? null;
  const address = body.address ?? null;
  const notes = body.notes ?? null;

  try {
    const result = await db.execute(sql`
      UPDATE customers SET
        name        = COALESCE(${name}, name),
        document_id = COALESCE(${documentId}, document_id),
        whatsapp    = COALESCE(${whatsapp}, whatsapp),
        email       = COALESCE(${email}, email),
        address     = COALESCE(${address}, address),
        notes       = COALESCE(${notes}, notes)
      WHERE id = ${id} AND organization_id = ${ctx.organizationId}
      RETURNING *
    `);

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Cliente no encontrado' },
        { status: 404 },
      );
    }

    return NextResponse.json(result.rows[0]);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al actualizar cliente',
      },
      { status: 400 },
    );
  }
}
