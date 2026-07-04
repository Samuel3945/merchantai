import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { cashierId?: string; currentPin?: string; newPin?: string };

// Un empleado CAMBIA su propio PIN desde la caja (siempre exige el PIN actual).
// El primer PIN NO se fija aquí: se activa con el enlace de un solo uso que envía
// el admin (POST /api/pos/cashiers/activate). Si el empleado no tiene PIN, esta
// ruta responde `not_activated` — así nadie puede "reclamar" a un cajero sin PIN
// desde la caja compartida (esa era la brecha de suplantación). Tampoco se puede
// quitar el PIN: el PIN por persona es obligatorio.
// - newPin debe ser 4 a 8 dígitos.
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
  const currentPin = body.currentPin ?? '';
  const newPin = (body.newPin ?? '').trim();
  if (!cashierId) {
    return NextResponse.json(
      { error: 'cashierId es requerido' },
      { status: 400 },
    );
  }
  // Un PIN por persona es obligatorio: newPin no puede quedar vacío.
  if (!/^\d{4,8}$/.test(newPin)) {
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

  // Sin PIN → aún no activado. No se permite fijar el primer PIN desde la caja
  // (eso lo hace el empleado con el enlace de activación); si no, cualquiera
  // podría reclamar a un cajero sin PIN. 403, no 401 (401 lo lee el POS como
  // sesión de caja expirada).
  if (!emp.pin) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_activated',
        error:
          'Este cajero aún no ha activado su PIN. Debe activarlo con el enlace que le envió el admin por WhatsApp.',
      },
      { status: 403 },
    );
  }

  // Cambiar el PIN exige el actual.
  const valid = await bcrypt.compare(currentPin, emp.pin);
  if (!valid) {
    return NextResponse.json(
      { ok: false, code: 'pin_incorrect', error: 'El PIN actual es incorrecto' },
      { status: 403 },
    );
  }

  const pinHash = await bcrypt.hash(newPin, 10);
  await db
    .update(posUsersSchema)
    .set({ pin: pinHash })
    .where(eq(posUsersSchema.id, emp.id));

  return NextResponse.json({ ok: true, hasPin: true });
}
