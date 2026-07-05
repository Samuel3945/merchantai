import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  getCourierBalance,
  listActiveCourierWalletBalances,
  recordCourierCashMovement,
} from '@/libs/courier-wallet';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { courierShiftsSchema, posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// El bolsillo del domiciliario. Un domiciliario es un pos_user activo con el
// módulo 'delivery'. Ver docs/caja-domiciliario/ESPECIFICACION.md.
//
// GET  ?courierId=…  → { balance } que ese domiciliario debería llevar encima.
//                       Sin courierId usa el operador activo (ctx.cashierId).
// POST { direction, amount, courierId, posTokenId?, note?, clientMovementId? }
//   direction ∈ { base_from_caja, handover_to_caja }. La venta cobrada
//   (sale_collected) NO pasa por aquí: se registra sola al entregar el pedido.

async function assertActiveCourier(
  orgId: string,
  courierId: string,
): Promise<boolean> {
  const [courier] = await db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, courierId),
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
        sql`'delivery' = ANY(${posUsersSchema.enabledModules})`,
      ),
    )
    .limit(1);
  return !!courier;
}

async function findActiveShift(orgId: string, courierId: string) {
  const [shift] = await db
    .select({
      id: courierShiftsSchema.id,
      posTokenId: courierShiftsSchema.posTokenId,
    })
    .from(courierShiftsSchema)
    .where(
      and(
        eq(courierShiftsSchema.organizationId, orgId),
        eq(courierShiftsSchema.courierId, courierId),
        isNull(courierShiftsSchema.endedAt),
      ),
    )
    .limit(1);
  return shift ?? null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  // Devuelve el bolsillo del operador activo (si es domiciliario) + la lista de
  // domiciliarios activos con su saldo (para el selector "¿a quién le prestas?").
  const couriers = await listActiveCourierWalletBalances(ctx.organizationId);
  const activeId = ctx.cashierId;
  const meWallet = activeId
    ? couriers.find(c => c.courierId === activeId) ?? null
    : null;

  return NextResponse.json({
    me: activeId
      ? {
          courierId: activeId,
          isCourier: meWallet != null,
          balance: meWallet?.balance ?? 0,
        }
      : null,
    couriers,
  });
}

type MovementBody = {
  direction?: string;
  amount?: number | string;
  courierId?: string;
  posTokenId?: string | null;
  note?: string | null;
  clientMovementId?: string | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: MovementBody;
  try {
    body = (await req.json()) as MovementBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const direction = body.direction;
  if (direction !== 'base_from_caja' && direction !== 'handover_to_caja') {
    return NextResponse.json(
      { error: `Dirección inválida: ${body.direction}` },
      { status: 400 },
    );
  }

  const courierId = body.courierId?.trim();
  if (!courierId) {
    return NextResponse.json(
      { error: 'courierId es requerido' },
      { status: 400 },
    );
  }
  if (!(await assertActiveCourier(ctx.organizationId, courierId))) {
    return NextResponse.json(
      { error: 'El domiciliario no existe o no está activo' },
      { status: 400 },
    );
  }

  const amountNum = Number.parseFloat(String(body.amount ?? 0));
  if (!(amountNum > 0)) {
    return NextResponse.json({ error: 'amount debe ser > 0' }, { status: 400 });
  }

  // La caja contraparte: la enviada por el dispositivo, si no la del turno del
  // domiciliario, si no la caja del propio token que hace la petición.
  const shift = await findActiveShift(ctx.organizationId, courierId);
  const posTokenId = body.posTokenId ?? shift?.posTokenId ?? ctx.tokenId;

  try {
    const movement = await recordCourierCashMovement({
      orgId: ctx.organizationId,
      courierId,
      direction,
      amount: amountNum,
      posTokenId,
      shiftId: shift?.id ?? null,
      note: body.note ?? null,
      createdBy: ctx.cashierId,
      clientMovementId: body.clientMovementId ?? null,
    });
    const balance = await getCourierBalance(ctx.organizationId, courierId);
    return NextResponse.json({ movement, balance }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al registrar el movimiento',
      },
      { status: 400 },
    );
  }
}
