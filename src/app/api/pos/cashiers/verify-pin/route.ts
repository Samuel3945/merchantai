import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { cashierId?: string; pin?: string };

// Verifica el PIN de un empleado al cambiar de perfil en la caja compartida.
// Si el empleado no tiene PIN configurado, el acceso es directo.
export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const cashierId = body.cashierId?.trim();
  const pin = body.pin ?? '';
  if (!cashierId) {
    return NextResponse.json(
      { error: 'cashierId es requerido' },
      { status: 400 },
    );
  }

  const [emp] = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      role: posUsersSchema.role,
      pin: posUsersSchema.pin,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, cashierId),
        eq(posUsersSchema.organizationId, ctx.organizationId),
        eq(posUsersSchema.active, true),
      ),
    )
    .limit(1);

  if (!emp) {
    return NextResponse.json(
      { error: 'Empleado no encontrado' },
      { status: 404 },
    );
  }

  const cashier = { id: emp.id, name: emp.name, role: emp.role };

  // Sin PIN configurado → acceso directo.
  if (!emp.pin) {
    return NextResponse.json({ ok: true, cashier });
  }

  const valid = await bcrypt.compare(pin, emp.pin);
  if (!valid) {
    return NextResponse.json(
      { ok: false, error: 'PIN incorrecto' },
      { status: 401 },
    );
  }

  return NextResponse.json({ ok: true, cashier });
}
