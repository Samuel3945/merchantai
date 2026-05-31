import type { CashMovementType } from '@/libs/cash-helpers';
import { NextResponse } from 'next/server';
import {
  EXPENSE_MOVEMENT_TYPES,
  findOpenSession,
  INCOME_MOVEMENT_TYPES,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import { cashMovementsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MovementBody = {
  type?: string;
  amount?: number | string;
  reason?: string;
};

const ALLOWED_TYPES: CashMovementType[] = [
  ...INCOME_MOVEMENT_TYPES,
  ...EXPENSE_MOVEMENT_TYPES,
];

export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
  );
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  let body: MovementBody;
  try {
    body = (await req.json()) as MovementBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const type = body.type as CashMovementType | undefined;
  if (!type || !ALLOWED_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `Tipo de movimiento inválido: ${body.type}` },
      { status: 400 },
    );
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json(
      { error: 'reason es requerido' },
      { status: 400 },
    );
  }

  const amount = toMoney(body.amount ?? 0);
  if (Number.parseFloat(amount) <= 0) {
    return NextResponse.json(
      { error: 'amount debe ser > 0' },
      { status: 400 },
    );
  }

  try {
    const movement = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId);
      if (!open) {
        throw new Error('No hay caja abierta. Abre la caja primero.');
      }

      const [created] = await tx
        .insert(cashMovementsSchema)
        .values({
          sessionId: open.id,
          organizationId: ctx.organizationId,
          type,
          amount,
          reason,
          createdBy: ctx.cashierName || 'Cajero',
        })
        .returning();

      if (!created) {
        throw new Error('No se pudo registrar el movimiento');
      }
      return created;
    });

    return NextResponse.json(movement, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al registrar movimiento',
      },
      { status: 400 },
    );
  }
}
