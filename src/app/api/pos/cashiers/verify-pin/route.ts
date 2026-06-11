import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createNotification } from '@/actions/notifications';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { posTokensSchema, posUsersSchema } from '@/models/Schema';

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
    const deviceRow = ctx.tokenId
      ? await db
          .select({ deviceName: posTokensSchema.deviceName })
          .from(posTokensSchema)
          .where(eq(posTokensSchema.id, ctx.tokenId))
          .limit(1)
          .then(r => r[0])
      : null;
    const deviceName = deviceRow?.deviceName ?? ctx.cashierName;

    logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
      action: 'employee.pin_failed',
      entityType: 'pos_user',
      entityId: emp.id,
      metadata: { employeeName: emp.name, deviceName, tokenId: ctx.tokenId },
    }).catch(() => null);
    createNotification({
      organizationId: ctx.organizationId,
      kind: 'sale_alert',
      severity: 'high',
      title: 'Intento de PIN incorrecto',
      message: `PIN incorrecto para el empleado "${emp.name}" en la caja "${deviceName}".`,
      payload: { employeeId: emp.id, employeeName: emp.name, tokenId: ctx.tokenId },
    }).catch(() => null);

    return NextResponse.json(
      { ok: false, error: 'PIN incorrecto' },
      { status: 401 },
    );
  }

  return NextResponse.json({ ok: true, cashier });
}
