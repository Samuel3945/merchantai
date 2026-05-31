import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { cashierId?: string; currentPin?: string; newPin?: string };

// Un empleado setea/cambia/quita su propio PIN desde la caja.
// - Si ya tiene PIN, exige el PIN actual.
// - newPin vacío → quita la protección (vuelve a acceso directo).
// - newPin debe ser 4 a 8 dígitos.
export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const cashierId = body.cashierId?.trim();
  const currentPin = body.currentPin ?? '';
  const newPin = (body.newPin ?? '').trim();
  if (!cashierId) {
    return NextResponse.json(
      { error: 'cashierId es requerido' },
      { status: 400 },
    );
  }
  if (newPin && !/^\d{4,8}$/.test(newPin)) {
    return NextResponse.json(
      { error: 'El PIN debe tener entre 4 y 8 dígitos' },
      { status: 400 },
    );
  }

  const [emp] = await db
    .select({ id: posUsersSchema.id, pin: posUsersSchema.pin })
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

  // Si ya tiene PIN, exigir el actual para cambiarlo/quitarlo.
  if (emp.pin) {
    const valid = await bcrypt.compare(currentPin, emp.pin);
    if (!valid) {
      return NextResponse.json(
        { error: 'El PIN actual es incorrecto' },
        { status: 401 },
      );
    }
  }

  const pinHash = newPin ? await bcrypt.hash(newPin, 10) : '';
  await db
    .update(posUsersSchema)
    .set({ pin: pinHash })
    .where(eq(posUsersSchema.id, emp.id));

  return NextResponse.json({ ok: true, hasPin: pinHash !== '' });
}
