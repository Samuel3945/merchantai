import { and, between, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { expensesSchema, posUsersSchema } from '@/models/Schema';

// Net-profit breakdown: gross margin minus period-allocated salaries and
// operating expenses. This is economic profit, not cash flow. Can be negative.
export type NetProfitStats = {
  grossMargin: number;
  // Prorated salaries: SUM(active employees' monthly salary) / 30 * days_in_range.
  // Uses a 30-day-month approximation for simplicity.
  salaries: number;
  // SUM of expenses.amount WHERE incurred_on BETWEEN range.start AND range.end.
  expenses: number;
  net: number;
};

function toNum(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Returns the number of calendar days in the range, inclusive of both endpoints.
// Example: 2024-01-01 to 2024-01-01 = 1 day; 2024-01-01 to 2024-01-31 = 31 days.
function daysInRange(start: string, end: string): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const startMs = Date.UTC(sy ?? 1970, (sm ?? 1) - 1, sd ?? 1);
  const endMs = Date.UTC(ey ?? 1970, (em ?? 1) - 1, ed ?? 1);
  return Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
}

// Net profit = gross margin − salaries (prorated) − operating expenses.
//
// Salary proration: we don't track exact days worked, so we approximate by
// dividing each employee's monthly salary by 30 and multiplying by the number
// of calendar days in the selected range. This is a stated approximation;
// the tooltip on the UI discloses it.
//
// Expenses: simple SUM of expenses.amount where incurred_on falls in the range.
// Salary + expense data is owner-only — callers must gate by org role.
export async function computeNetProfit(
  orgId: string,
  start: string,
  end: string,
  grossMargin: number,
): Promise<NetProfitStats> {
  const days = daysInRange(start, end);

  const [salaryResult, expenseResult] = await Promise.all([
    // Sum only active employees with a non-null salary.
    db
      .select({
        totalMonthly: sql<string>`COALESCE(SUM(${posUsersSchema.salary}::numeric), 0)`,
      })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.organizationId, orgId),
          eq(posUsersSchema.active, true),
          isNotNull(posUsersSchema.salary),
        ),
      ),
    // Sum expenses with incurred_on within the range.
    db
      .select({
        total: sql<string>`COALESCE(SUM(${expensesSchema.amount}::numeric), 0)`,
      })
      .from(expensesSchema)
      .where(
        and(
          eq(expensesSchema.organizationId, orgId),
          between(expensesSchema.incurredOn, start, end),
        ),
      ),
  ]);

  const monthlyTotal = toNum(salaryResult[0]?.totalMonthly);
  // 30-day-month proration: daily rate × days in range. Rounded to whole pesos.
  const salaries = Math.round((monthlyTotal / 30) * days);

  const expenses = toNum(expenseResult[0]?.total);
  const net = grossMargin - salaries - expenses;

  return { grossMargin, salaries, expenses, net };
}
