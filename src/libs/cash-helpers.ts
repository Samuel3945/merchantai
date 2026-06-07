import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { formatSaleNumber } from '@/libs/sale-number';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  salePaymentsSchema,
  salesSchema,
} from '@/models/Schema';

export type CashSession = typeof cashSessionsSchema.$inferSelect;
export type CashMovement = typeof cashMovementsSchema.$inferSelect;
export type CashMovementType
  = (typeof cashMovementsSchema.type.enumValues)[number];

export const CASH_PAYMENT_METHODS = ['efectivo', 'cash'];

// Cash coming INTO the drawer. `adjustment` is a manual reconciliation entry
// that raises expected cash — it existed in the enum but was counted nowhere
// before, that gap is fixed here.
export const INCOME_MOVEMENT_TYPES: CashMovementType[] = [
  'sale',
  'deposit',
  'adjustment',
  // Cobro de fiado en efectivo: real cash into the drawer, so it raises the
  // expected amount for the arqueo. It is NOT revenue (Finanzas excludes it —
  // revenue was booked when the fiado sale happened), only drawer cash.
  'fiado_payment',
];

// Cash leaving the drawer. This DOES include `withdrawal`: a security withdrawal
// still removes physical cash from the register, so it belongs in the Caja
// "expected cash" calculation.
//
// Finanzas (analytics.ts, dashboard.ts) deliberately uses a NARROWER set —
// expense + salary + inventory_purchase — because a security withdrawal only
// relocates cash to a safe/bank and is not a P&L expense, `advance` (vale de
// empleado) is a receivable against future salary, and `adjustment` is a
// reconciliation entry, not a cost.
export const EXPENSE_MOVEMENT_TYPES: CashMovementType[] = [
  'expense',
  'salary',
  'inventory_purchase',
  'withdrawal',
  'advance',
];

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

export async function findOpenSession(
  executor: Executor,
  organizationId: string,
): Promise<CashSession | undefined> {
  const [session] = await executor
    .select()
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, organizationId),
        eq(cashSessionsSchema.status, 'open'),
      ),
    )
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(1);
  return session;
}

export type CashBreakdown = {
  /** Base inicial — opening float entered when the session was opened. */
  opening: number;
  /** Ventas en efectivo de la sesión (type = sale). */
  cashSales: number;
  /** Entradas manuales: ingresos y ajustes (deposit + adjustment). */
  entradas: number;
  /** Salidas: todo el efectivo que salió del cajón (gastos + retiros). */
  salidas: number;
  /** Efectivo esperado = opening + cashSales + entradas - salidas. */
  expected: number;
  /** Cantidad de movimientos de la sesión. */
  movementCount: number;
};

/**
 * Single source of truth for the Caja numbers. Answers the only question the
 * Caja screen cares about — how much cash should physically be in the register
 * right now — broken down so the header can show base / ventas / entradas /
 * salidas without recomputing on the client.
 */
export async function computeCashBreakdown(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openingAmount'>,
): Promise<CashBreakdown> {
  const [row] = await executor
    .select({
      cashSales: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} = 'sale'), 0)::text`,
      entradas: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} IN ('deposit','adjustment','fiado_payment')), 0)::text`,
      salidas: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} IN ('expense','salary','inventory_purchase','withdrawal','advance')), 0)::text`,
      movementCount: sql<number>`COUNT(*)::int`,
    })
    .from(cashMovementsSchema)
    .where(eq(cashMovementsSchema.sessionId, session.id));

  const opening = Number.parseFloat(session.openingAmount) || 0;
  const cashSales = Number.parseFloat(row?.cashSales ?? '0') || 0;
  const entradas = Number.parseFloat(row?.entradas ?? '0') || 0;
  const salidas = Number.parseFloat(row?.salidas ?? '0') || 0;
  const expected = Number.parseFloat(
    (opening + cashSales + entradas - salidas).toFixed(2),
  );

  return {
    opening,
    cashSales,
    entradas,
    salidas,
    expected,
    movementCount: Number(row?.movementCount ?? 0),
  };
}

export async function computeExpectedAmount(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openingAmount'>,
): Promise<number> {
  const { expected } = await computeCashBreakdown(executor, session);
  return expected;
}

export async function recordCashMovement(
  saleId: string,
  total: number | string,
  ctx?: { organizationId: string; userId: string },
): Promise<CashMovement | null> {
  let userId: string | undefined;
  let orgId: string | undefined;

  if (ctx) {
    userId = ctx.userId;
    orgId = ctx.organizationId;
  } else {
    const session = await auth();
    userId = session.userId ?? undefined;
    orgId = session.orgId ?? undefined;
  }

  if (!userId || !orgId) {
    return null;
  }

  const open = await findOpenSession(db, orgId);
  if (!open) {
    return null;
  }

  // One lookup feeds both the cash-detection fallback (paymentType) and the
  // human-readable movement label (saleNumber). Using the per-org sale number
  // keeps the Caja ledger consistent with the Sales view (#1001) instead of a
  // raw UUID prefix.
  const [sale] = await db
    .select({
      paymentType: salesSchema.paymentType,
      saleNumber: salesSchema.saleNumber,
    })
    .from(salesSchema)
    .where(eq(salesSchema.id, saleId))
    .limit(1);

  const [cashRow] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
    })
    .from(salePaymentsSchema)
    .where(
      and(
        eq(salePaymentsSchema.saleId, saleId),
        sql`LOWER(${salePaymentsSchema.method}) IN ('efectivo', 'cash')`,
      ),
    );

  let cashAmount = Number.parseFloat(cashRow?.sum ?? '0') || 0;

  if (cashAmount === 0) {
    const pt = sale?.paymentType?.toLowerCase();
    if (pt && CASH_PAYMENT_METHODS.includes(pt)) {
      cashAmount = Number.parseFloat(toMoney(total)) || 0;
    } else {
      return null;
    }
  }

  if (cashAmount <= 0) {
    return null;
  }

  const [created] = await db
    .insert(cashMovementsSchema)
    .values({
      sessionId: open.id,
      organizationId: orgId,
      type: 'sale',
      amount: toMoney(cashAmount),
      reason: `Venta ${formatSaleNumber(sale?.saleNumber ?? null)}`,
      createdBy: userId,
      saleId,
    })
    .returning();

  return created ?? null;
}
