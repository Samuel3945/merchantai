import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
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

export const INCOME_MOVEMENT_TYPES: CashMovementType[] = ['sale', 'deposit'];
export const EXPENSE_MOVEMENT_TYPES: CashMovementType[] = [
  'expense',
  'salary',
  'inventory_purchase',
  'withdrawal',
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

export async function computeExpectedAmount(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openingAmount'>,
): Promise<number> {
  const [row] = await executor
    .select({
      income: sql<string>`COALESCE(SUM(CASE WHEN ${cashMovementsSchema.type} IN ('sale','deposit') THEN ${cashMovementsSchema.amount} ELSE 0 END), 0)::text`,
      expense: sql<string>`COALESCE(SUM(CASE WHEN ${cashMovementsSchema.type} IN ('expense','salary','inventory_purchase','withdrawal') THEN ${cashMovementsSchema.amount} ELSE 0 END), 0)::text`,
    })
    .from(cashMovementsSchema)
    .where(eq(cashMovementsSchema.sessionId, session.id));

  const opening = Number.parseFloat(session.openingAmount) || 0;
  const income = Number.parseFloat(row?.income ?? '0') || 0;
  const expense = Number.parseFloat(row?.expense ?? '0') || 0;
  return Number.parseFloat((opening + income - expense).toFixed(2));
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
    const [sale] = await db
      .select({ paymentType: salesSchema.paymentType })
      .from(salesSchema)
      .where(eq(salesSchema.id, saleId))
      .limit(1);

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
      reason: `Venta #${saleId.slice(0, 6).toUpperCase()}`,
      createdBy: userId,
      saleId,
    })
    .returning();

  return created ?? null;
}
