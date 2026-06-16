import type { CashMovementType } from '@/libs/cash-helpers';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  EXPENSE_MOVEMENT_TYPES,
  findOpenSession,
  INCOME_MOVEMENT_TYPES,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { cashMovementsSchema, suppliersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MovementBody = {
  type?: string;
  amount?: number | string;
  reason?: string;
  // Optional: links a "Pago a proveedor" movement to a supplier. The device
  // sends the supplier id chosen from /pos/suppliers; it is validated against
  // the caja's org before being persisted to cash_movements.supplier_id.
  supplierId?: string | null;
};

const ALLOWED_TYPES: CashMovementType[] = [
  ...INCOME_MOVEMENT_TYPES,
  ...EXPENSE_MOVEMENT_TYPES,
];

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

  // Optional supplier link (Pago a proveedor). Must be a real, active supplier
  // of this caja's org — guards against stale or cross-tenant ids from the device.
  const supplierId = body.supplierId ?? null;
  if (supplierId) {
    const [supplier] = await db
      .select({ id: suppliersSchema.id })
      .from(suppliersSchema)
      .where(
        and(
          eq(suppliersSchema.id, supplierId),
          eq(suppliersSchema.organizationId, ctx.organizationId),
          eq(suppliersSchema.status, 'active'),
        ),
      )
      .limit(1);
    if (!supplier) {
      return NextResponse.json(
        { error: 'El proveedor seleccionado no existe o está archivado' },
        { status: 400 },
      );
    }
  }

  try {
    const movement = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
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
          supplierId,
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
