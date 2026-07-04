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

// Wrong-PIN lockout: after MAX_ATTEMPTS consecutive failures the cashier is
// locked for LOCK_MINUTES. A correct PIN or a fresh activation clears both.
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

// Verifica el PIN de un empleado al cambiar de perfil en la caja compartida.
// Cada empleado DEBE tener su propio PIN (Option B): sin PIN configurado no se
// puede entrar — el empleado activa su PIN con el enlace que le envía el admin.
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
      pinFailedAttempts: posUsersSchema.pinFailedAttempts,
      pinLockedUntil: posUsersSchema.pinLockedUntil,
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

  // Stamp who is now operating this caja so the admin panel shows the live
  // operator. Best-effort — never block the login on this write.
  const markOperating = async () => {
    if (!ctx.tokenId) {
      return;
    }
    try {
      await db
        .update(posTokensSchema)
        .set({ currentCashierId: emp.id, currentCashierAt: new Date() })
        .where(eq(posTokensSchema.id, ctx.tokenId));
    } catch {
      // best-effort
    }
  };

  // Sin PIN configurado → el empleado aún no activó su PIN. NO se entra: sería la
  // brecha de suplantación (cualquiera entraría como él). 403, no 401 (401 lo
  // interpreta el POS como sesión de caja expirada y cerraría la caja entera).
  if (!emp.pin) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_activated',
        error:
          'Este cajero aún no ha activado su PIN. Revisa tu WhatsApp o pide al admin que reenvíe el enlace.',
      },
      { status: 403 },
    );
  }

  // Lockout activo → rechazar sin siquiera comparar.
  if (emp.pinLockedUntil && emp.pinLockedUntil.getTime() > Date.now()) {
    const mins = Math.max(
      1,
      Math.ceil((emp.pinLockedUntil.getTime() - Date.now()) / 60000),
    );
    return NextResponse.json(
      {
        ok: false,
        code: 'locked',
        error: `Demasiados intentos. Bloqueado, intenta en ${mins} minuto${mins === 1 ? '' : 's'} o pide al admin que reenvíe tu enlace.`,
      },
      { status: 403 },
    );
  }

  const valid = await bcrypt.compare(pin, emp.pin);
  if (!valid) {
    const nextAttempts = (emp.pinFailedAttempts ?? 0) + 1;
    const shouldLock = nextAttempts >= MAX_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCK_MINUTES * 60000)
      : null;

    // Reaching the cap locks the account and resets the counter; otherwise just
    // bump the counter. Best-effort persist — a failed write must not turn a
    // wrong PIN into a 500.
    await db
      .update(posUsersSchema)
      .set({
        pinFailedAttempts: shouldLock ? 0 : nextAttempts,
        pinLockedUntil: lockedUntil,
      })
      .where(eq(posUsersSchema.id, emp.id))
      .catch(() => null);

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
      metadata: {
        employeeName: emp.name,
        deviceName,
        tokenId: ctx.tokenId,
        attempts: nextAttempts,
        locked: shouldLock,
      },
    }).catch(() => null);
    createNotification({
      organizationId: ctx.organizationId,
      kind: 'sale_alert',
      severity: 'high',
      title: shouldLock ? 'Cajero bloqueado por PIN' : 'Intento de PIN incorrecto',
      message: shouldLock
        ? `El empleado "${emp.name}" fue bloqueado tras ${MAX_ATTEMPTS} intentos de PIN en la caja "${deviceName}".`
        : `PIN incorrecto para el empleado "${emp.name}" en la caja "${deviceName}".`,
      payload: { employeeId: emp.id, employeeName: emp.name, tokenId: ctx.tokenId },
    }).catch(() => null);

    if (shouldLock) {
      return NextResponse.json(
        {
          ok: false,
          code: 'locked',
          error: `Demasiados intentos. Bloqueado, intenta en ${LOCK_MINUTES} minutos o pide al admin que reenvíe tu enlace.`,
        },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { ok: false, code: 'pin_incorrect', error: 'PIN incorrecto' },
      { status: 403 },
    );
  }

  // PIN correcto → limpiar el contador/lockout y marcar operando.
  if ((emp.pinFailedAttempts ?? 0) !== 0 || emp.pinLockedUntil) {
    await db
      .update(posUsersSchema)
      .set({ pinFailedAttempts: 0, pinLockedUntil: null })
      .where(eq(posUsersSchema.id, emp.id))
      .catch(() => null);
  }

  await markOperating();
  return NextResponse.json({ ok: true, cashier });
}
