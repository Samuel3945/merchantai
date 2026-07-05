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

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  computeExpectedAmount,
  findOpenSession,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  courierCashMovementsSchema,
  courierShiftsSchema,
  posUsersSchema,
  salePaymentsSchema,
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
      const token = input.posTokenId ?? null;
      // Sesión destino: la abierta del token; si ya no hay (el cajero cerró la
      // caja antes de que sincronizara este movimiento offline), la más reciente
      // de ese token. Ver ESPECIFICACION §5: cerrar es offline con excedente y se
      // reconcilia a exacto cuando el movimiento sube.
      let session = await findOpenSession(tx, input.orgId, token);
      if (!session) {
        const [recent] = await tx
          .select()
          .from(cashSessionsSchema)
          .where(
            and(
              eq(cashSessionsSchema.organizationId, input.orgId),
              token === null
                ? isNull(cashSessionsSchema.posTokenId)
                : eq(cashSessionsSchema.posTokenId, token),
            ),
          )
          .orderBy(desc(cashSessionsSchema.openedAt))
          .limit(1);
        session = recent;
      }
      if (!session) {
        throw new Error(
          'No hay caja para registrar este movimiento. Abre la caja primero.',
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

      // Reconciliación offline: si la sesión ya estaba CERRADA, su arqueo quedó
      // congelado con excedente/faltante. Recalculamos expected y difference
      // (counted no cambia) para que quede exacto tras subir el movimiento.
      if (session.status === 'closed' && session.countedAmount != null) {
        const expected = await computeExpectedAmount(tx, session);
        const counted = Number.parseFloat(session.countedAmount) || 0;
        await tx
          .update(cashSessionsSchema)
          .set({
            expectedAmount: toMoney(expected),
            difference: toMoney(round2(counted - expected)),
          })
          .where(eq(cashSessionsSchema.id, session.id));
      }
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

/**
 * Desvía el efectivo cobrado en una venta a domicilio al bolsillo del
 * domiciliario, en vez de dejarlo en el cajón (la plata la lleva él, ver
 * ESPECIFICACION §3). Best-effort, post-commit del sale + status flip.
 *
 * Modelo: createSaleForOrg ya contabilizó la venta en la caja del turno (un
 * cash_movement type='sale'). Aquí compensamos ese ingreso con un `withdrawal`
 * en la MISMA sesión (net cajón = 0) y acreditamos el efectivo al bolsillo del
 * domiciliario (sale_collected). Idempotente por saleId: si ya se desvió, no
 * duplica. Solo desvía la porción EN EFECTIVO (mixto/digital no aplica).
 */
export async function recordDeliveryCashCollected(args: {
  orgId: string;
  saleId: string;
  courierId: string;
  posTokenId?: string | null;
  executor?: Executor;
}): Promise<CourierCashMovement | null> {
  const run = async (tx: Executor): Promise<CourierCashMovement | null> => {
    // Idempotencia: una venta se desvía UNA sola vez (reintentos / re-delivery).
    const [already] = await tx
      .select()
      .from(courierCashMovementsSchema)
      .where(
        and(
          eq(courierCashMovementsSchema.saleId, args.saleId),
          eq(courierCashMovementsSchema.direction, 'sale_collected'),
        ),
      )
      .limit(1);
    if (already) {
      return already;
    }

    // Porción en efectivo de la venta (mixto: solo la parte efectivo).
    const [cashRow] = await tx
      .select({
        sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
      })
      .from(salePaymentsSchema)
      .where(
        and(
          eq(salePaymentsSchema.saleId, args.saleId),
          sql`LOWER(${salePaymentsSchema.method}) IN ('efectivo', 'cash')`,
        ),
      );
    const cash = Number.parseFloat(cashRow?.sum ?? '0') || 0;
    if (cash <= 0) {
      return null;
    }
    const amount = toMoney(cash);

    // Compensa el ingreso de la venta en la MISMA sesión donde cayó (net = 0),
    // así el cajón deja de "esperar" un efectivo que físicamente lleva el domi.
    const [saleMov] = await tx
      .select({ sessionId: cashMovementsSchema.sessionId })
      .from(cashMovementsSchema)
      .where(
        and(
          eq(cashMovementsSchema.saleId, args.saleId),
          eq(cashMovementsSchema.type, 'sale'),
        ),
      )
      .limit(1);
    if (saleMov) {
      await tx.insert(cashMovementsSchema).values({
        sessionId: saleMov.sessionId,
        organizationId: args.orgId,
        type: 'withdrawal',
        amount,
        reason: 'Efectivo del domicilio lo lleva el domiciliario',
        saleId: args.saleId,
        createdBy: 'system',
      });
    }

    // Turno activo del domiciliario (para atar el movimiento al turno).
    const [shift] = await tx
      .select({ id: courierShiftsSchema.id })
      .from(courierShiftsSchema)
      .where(
        and(
          eq(courierShiftsSchema.organizationId, args.orgId),
          eq(courierShiftsSchema.courierId, args.courierId),
          isNull(courierShiftsSchema.endedAt),
        ),
      )
      .limit(1);

    const [row] = await tx
      .insert(courierCashMovementsSchema)
      .values({
        organizationId: args.orgId,
        shiftId: shift?.id ?? null,
        courierId: args.courierId,
        posTokenId: args.posTokenId ?? null,
        direction: 'sale_collected',
        amount,
        saleId: args.saleId,
        createdBy: 'system',
      })
      .returning();

    return row ?? null;
  };

  return args.executor ? run(args.executor) : db.transaction(run);
}
