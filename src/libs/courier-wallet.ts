// Bolsillo del domiciliario (courier wallet).
//
// El domiciliario es un contenedor de efectivo con SALDO PROPIO. Su saldo se
// DERIVA del ledger append-only `courier_cash_movements` — nunca se guarda un
// valor absoluto (misma regla que el FIFO de stock). Ver
// docs/caja-domiciliario/ESPECIFICACION.md.
//
//   saldo = Σ(base_from_caja + sale_collected) − Σ(handover_to_caja)
//
// Base y entrega tocan el CAJÓN: escriben además un cash_movement en la sesión
// abierta de la caja contraparte (withdrawal / deposit) para que el arqueo del
// cajón cuadre solo, sin enseñarle nada nuevo. `sale_collected` NO toca el
// cajón (la plata la lleva el domiciliario, no entra al registro).

import { and, eq, sql } from 'drizzle-orm';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  cashMovementsSchema,
  courierCashMovementsSchema,
  posUsersSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CourierCashDirection
  = (typeof courierCashMovementsSchema.$inferSelect)['direction'];

export type CourierCashMovement = typeof courierCashMovementsSchema.$inferSelect;

function round2(n: number): number {
  return Number.parseFloat(n.toFixed(2));
}

// Direcciones que SUMAN al saldo del domiciliario (plata que le llega).
const INFLOW_DIRECTIONS: CourierCashDirection[] = [
  'base_from_caja',
  'sale_collected',
];

/**
 * Saldo del domiciliario a partir de sus filas del ledger. Función pura para
 * poder testear la aritmética sin base de datos.
 */
export function computeCourierBalance(
  rows: ReadonlyArray<Pick<CourierCashMovement, 'direction' | 'amount'>>,
): number {
  let balance = 0;
  for (const r of rows) {
    const amt = Number.parseFloat(r.amount) || 0;
    balance += INFLOW_DIRECTIONS.includes(r.direction) ? amt : -amt;
  }
  return round2(balance);
}

/** Saldo que el domiciliario debería llevar encima ahora mismo. */
export async function getCourierBalance(
  orgId: string,
  courierId: string,
  executor: Executor = db,
): Promise<number> {
  const [row] = await executor
    .select({
      inflow: sql<string>`COALESCE(SUM(${courierCashMovementsSchema.amount}) FILTER (WHERE ${courierCashMovementsSchema.direction} IN ('base_from_caja','sale_collected')), 0)::text`,
      outflow: sql<string>`COALESCE(SUM(${courierCashMovementsSchema.amount}) FILTER (WHERE ${courierCashMovementsSchema.direction} = 'handover_to_caja'), 0)::text`,
    })
    .from(courierCashMovementsSchema)
    .where(
      and(
        eq(courierCashMovementsSchema.organizationId, orgId),
        eq(courierCashMovementsSchema.courierId, courierId),
      ),
    );
  const inflow = Number.parseFloat(row?.inflow ?? '0') || 0;
  const outflow = Number.parseFloat(row?.outflow ?? '0') || 0;
  return round2(inflow - outflow);
}

export type CourierWalletBalance = {
  courierId: string;
  name: string;
  balance: number;
};

/**
 * Saldo "en la calle" de cada domiciliario ACTIVO (pos_user activo con el módulo
 * 'delivery'). Alimenta el bolsillo de domiciliarios en Tesorería, que solo
 * aparece si esta lista no está vacía.
 */
export async function listActiveCourierWalletBalances(
  orgId: string,
  executor: Executor = db,
): Promise<CourierWalletBalance[]> {
  const rows = await executor
    .select({
      courierId: posUsersSchema.id,
      name: posUsersSchema.name,
      inflow: sql<string>`COALESCE(SUM(${courierCashMovementsSchema.amount}) FILTER (WHERE ${courierCashMovementsSchema.direction} IN ('base_from_caja','sale_collected')), 0)::text`,
      outflow: sql<string>`COALESCE(SUM(${courierCashMovementsSchema.amount}) FILTER (WHERE ${courierCashMovementsSchema.direction} = 'handover_to_caja'), 0)::text`,
    })
    .from(posUsersSchema)
    .leftJoin(
      courierCashMovementsSchema,
      and(
        eq(courierCashMovementsSchema.courierId, posUsersSchema.id),
        eq(courierCashMovementsSchema.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
        sql`'delivery' = ANY(${posUsersSchema.enabledModules})`,
      ),
    )
    .groupBy(posUsersSchema.id, posUsersSchema.name);

  return rows.map(r => ({
    courierId: r.courierId,
    name: r.name,
    balance: round2(
      (Number.parseFloat(r.inflow ?? '0') || 0)
      - (Number.parseFloat(r.outflow ?? '0') || 0),
    ),
  }));
}

export type RecordCourierCashInput = {
  orgId: string;
  courierId: string;
  direction: CourierCashDirection;
  amount: number | string;
  /** Caja contraparte (de dónde sale la base / a dónde entra la entrega). */
  posTokenId?: string | null;
  shiftId?: string | null;
  saleId?: string | null;
  note?: string | null;
  /** pos_user id que registró (una sola firma, sin confirmación). */
  createdBy?: string | null;
  /** UUID del dispositivo → idempotencia offline. */
  clientMovementId?: string | null;
  executor?: Executor;
};

/**
 * Registra un movimiento del bolsillo del domiciliario.
 *
 * - base_from_caja / handover_to_caja: escriben ADEMÁS un cash_movement en la
 *   sesión abierta de la caja (withdrawal / deposit) para que el arqueo cuadre.
 * - sale_collected: solo toca el bolsillo (la venta no entra al cajón).
 *
 * Idempotente por `clientMovementId`: un reintento de la cola offline devuelve la
 * fila existente sin duplicar. Corre en su propia transacción si no recibe una.
 */
export async function recordCourierCashMovement(
  input: RecordCourierCashInput,
): Promise<CourierCashMovement | null> {
  const run = async (tx: Executor): Promise<CourierCashMovement | null> => {
    // Idempotencia offline: si ya existe la fila para este client id, no dupliques.
    if (input.clientMovementId) {
      const [existing] = await tx
        .select()
        .from(courierCashMovementsSchema)
        .where(
          and(
            eq(courierCashMovementsSchema.organizationId, input.orgId),
            eq(
              courierCashMovementsSchema.clientMovementId,
              input.clientMovementId,
            ),
          ),
        )
        .limit(1);
      if (existing) {
        return existing;
      }
    }

    const amount = toMoney(input.amount);
    if (Number.parseFloat(amount) <= 0) {
      throw new Error('El monto debe ser mayor a cero.');
    }

    // Lado del cajón para base y entrega — así el arqueo se ajusta solo.
    if (
      input.direction === 'base_from_caja'
      || input.direction === 'handover_to_caja'
    ) {
      const session = await findOpenSession(
        tx,
        input.orgId,
        input.posTokenId ?? null,
      );
      if (!session) {
        throw new Error(
          'La caja debe estar abierta para registrar este movimiento.',
        );
      }
      const isBase = input.direction === 'base_from_caja';
      await tx.insert(cashMovementsSchema).values({
        sessionId: session.id,
        organizationId: input.orgId,
        // Base = sale efectivo del cajón (salida); entrega = entra al cajón.
        type: isBase ? 'withdrawal' : 'deposit',
        amount,
        reason:
          input.note?.trim()
          || (isBase ? 'Base a domiciliario' : 'Entrega de domiciliario'),
        createdBy: input.createdBy ?? 'system',
      });
    }

    const [row] = await tx
      .insert(courierCashMovementsSchema)
      .values({
        organizationId: input.orgId,
        shiftId: input.shiftId ?? null,
        courierId: input.courierId,
        posTokenId: input.posTokenId ?? null,
        direction: input.direction,
        amount,
        saleId: input.saleId ?? null,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
        clientMovementId: input.clientMovementId ?? null,
      })
      .returning();

    return row ?? null;
  };

  return input.executor ? run(input.executor) : db.transaction(run);
}
