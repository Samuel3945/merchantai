/**
 * Unified gastos query — reads the expenses table org-scoped with
 * date-range + optional category filter. Resolves origin label via
 * LEFT JOIN presence:
 *   - treasury_movements.expense_id => 'treasury'
 *   - cash_movements.expense_id     => 'pos'
 *   - neither                        => 'legacy'
 *
 * Pure lib function: takes an Executor so it is PGLite-testable.
 * The server action wrapper (listGastosAction) lives in actions/treasury.ts.
 */
import type { db } from '@/libs/DB';
import { and, between, desc, eq, isNotNull } from 'drizzle-orm';
import { cashMovementsSchema, expensesSchema, treasuryMovementsSchema } from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GastoOrigin = 'treasury' | 'pos' | 'legacy';

export type GastoRow = {
  id: string;
  organizationId: string;
  amount: string;
  category: string;
  description: string | null;
  incurredOn: string;
  createdBy: string | null;
  createdAt: Date;
  origin: GastoOrigin;
};

export type ListGastosInput = {
  organizationId: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  category?: string;
};

export type ListGastosResult = {
  rows: GastoRow[];
  total: number;
};

export async function listGastos(
  executor: Executor,
  input: ListGastosInput,
): Promise<ListGastosResult> {
  const { organizationId, start, end, category } = input;

  const conditions = [
    eq(expensesSchema.organizationId, organizationId),
    between(expensesSchema.incurredOn, start, end),
  ];
  if (category) {
    conditions.push(eq(expensesSchema.category, category));
  }

  // LEFT JOIN treasury_movements to detect treasury origin.
  // LEFT JOIN cash_movements to detect POS origin.
  // CASE WHEN resolves priority: treasury > pos > legacy.
  const rows = await executor
    .select({
      id: expensesSchema.id,
      organizationId: expensesSchema.organizationId,
      amount: expensesSchema.amount,
      category: expensesSchema.category,
      description: expensesSchema.description,
      incurredOn: expensesSchema.incurredOn,
      createdBy: expensesSchema.createdBy,
      createdAt: expensesSchema.createdAt,
      treasuryMovId: treasuryMovementsSchema.id,
      cashMovId: cashMovementsSchema.id,
    })
    .from(expensesSchema)
    .leftJoin(
      treasuryMovementsSchema,
      and(
        eq(treasuryMovementsSchema.expenseId, expensesSchema.id),
        isNotNull(treasuryMovementsSchema.expenseId),
      ),
    )
    .leftJoin(
      cashMovementsSchema,
      and(
        eq(cashMovementsSchema.expenseId, expensesSchema.id),
        isNotNull(cashMovementsSchema.expenseId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(expensesSchema.incurredOn), desc(expensesSchema.createdAt));

  const gastosRows: GastoRow[] = rows.map(r => ({
    id: r.id,
    organizationId: r.organizationId,
    amount: r.amount,
    category: r.category,
    description: r.description ?? null,
    incurredOn: r.incurredOn,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    origin: r.treasuryMovId
      ? 'treasury'
      : r.cashMovId
        ? 'pos'
        : 'legacy',
  }));

  // Compute total from raw amount strings — avoid a second query.
  const total = gastosRows.reduce((sum, r) => sum + Number.parseFloat(r.amount), 0);

  return { rows: gastosRows, total };
}
