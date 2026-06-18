import type { CashMovementType } from '@/libs/cash-helpers';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import {
  EXPENSE_MOVEMENT_TYPES,
  findOpenSession,
  INCOME_MOVEMENT_TYPES,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { recordPosGastoBridge } from '@/libs/pos-gasto-bridge';
import { recordInflowSourceDebit } from '@/libs/treasury';
import { cashMovementsSchema, suppliersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Origin discriminator for entrada (inflow) movements.
// 'internal': cash from another treasury container (cofre, banco).
//             Requires fromAccountId. Records a companion treasury salida.
// 'external': direct owner injection — no source container.
// Omitted / null: legacy device — treated as a plain cash entrada (backward-compat).
type InternalOrigin = {
  kind: 'internal';
  fromAccountId?: string;
};

type ExternalOrigin = {
  kind: 'external';
};

type MovementBody = {
  type?: string;
  amount?: number | string;
  reason?: string;
  // Optional: links a "Pago a proveedor" movement to a supplier. The device
  // sends the supplier id chosen from /pos/suppliers; it is validated against
  // the caja's org before being persisted to cash_movements.supplier_id.
  supplierId?: string | null;
  // Optional (slice 3): origin discriminator for entrada movements.
  // Legacy devices that omit this field keep working unchanged (backward-compat).
  origin?: InternalOrigin | ExternalOrigin | null;
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

  // Validate origin when provided on income movement types.
  const isIncome = INCOME_MOVEMENT_TYPES.includes(type);
  const origin = body.origin ?? null;

  if (origin && origin.kind === 'internal') {
    if (!isIncome) {
      return NextResponse.json(
        { error: 'origin solo es válido para movimientos de ingreso (entrada)' },
        { status: 400 },
      );
    }
    if (!origin.fromAccountId) {
      return NextResponse.json(
        { error: 'origin.fromAccountId es requerido para origin.kind="internal"' },
        { status: 400 },
      );
    }
  }

  if (origin && origin.kind === 'external' && !isIncome) {
    return NextResponse.json(
      { error: 'origin solo es válido para movimientos de ingreso (entrada)' },
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

      // For INTERNAL-origin entradas: record a treasury salida from the source
      // container BEFORE inserting the cash_movements row. This validates the
      // source (active, org-scoped, sufficient balance) inside the transaction,
      // so any validation failure rolls back both writes atomically.
      let treasuryMovementId: string | null = null;

      if (origin?.kind === 'internal' && origin.fromAccountId) {
        const treasuryRow = await recordInflowSourceDebit(tx, {
          organizationId: ctx.organizationId,
          fromAccountId: origin.fromAccountId,
          amount,
          reason,
          createdBy: ctx.cashierName || 'Cajero',
        });
        treasuryMovementId = treasuryRow.id;
      }

      // gasto-treasury-unification slice 1: POS→P&L bridge.
      // When type='expense', dual-write: expenses (P&L anchor) + cash_movements
      // (with expense_id back-pointer). All other types keep the plain insert.
      let created: typeof cashMovementsSchema.$inferSelect | undefined;

      if (type === 'expense') {
        const bridge = await recordPosGastoBridge(tx, {
          organizationId: ctx.organizationId,
          sessionId: open.id,
          amount,
          reason,
          createdBy: ctx.cashierName || 'Cajero',
        });

        // Fetch the full cash_movements row to return to the device (201 body).
        const [row] = await tx
          .select()
          .from(cashMovementsSchema)
          .where(eq(cashMovementsSchema.id, bridge.movementId))
          .limit(1);
        created = row;

        // Audit: log that a POS gasto was bridged to the P&L expenses table.
        await logAction({
          organizationId: ctx.organizationId,
          actor: resolvePosActor(ctx),
          action: 'pos.gasto.bridged',
          entityType: 'expense',
          entityId: bridge.expenseId,
          after: {
            expenseId: bridge.expenseId,
            movementId: bridge.movementId,
            amount,
            reason,
          },
          metadata: { cashierName: ctx.cashierName, sessionId: open.id },
          ip:
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')
            || null,
          userAgent: req.headers.get('user-agent'),
        });
      } else {
        const [row] = await tx
          .insert(cashMovementsSchema)
          .values({
            sessionId: open.id,
            organizationId: ctx.organizationId,
            type,
            amount,
            reason,
            supplierId,
            createdBy: ctx.cashierName || 'Cajero',
            // Slice 3: persist origin discriminator + treasury link for internal entradas
            origin: origin?.kind ?? null,
            treasuryMovementId,
          })
          .returning();
        created = row;
      }

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
