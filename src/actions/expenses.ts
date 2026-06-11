'use server';

import type { ActionResult } from '@/libs/action-result';
import { auth } from '@clerk/nextjs/server';
import { and, between, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { expensesSchema } from '@/models/Schema';

// Expense categories suggested by the UI. The column is free-text, so the
// owner is never blocked from typing a custom category.
export const EXPENSE_CATEGORIES = [
  'servicios',
  'arriendo',
  'transporte',
  'marketing',
  'impuestos',
  'otros',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

// Only org:admin (the owner) may read or write expense data. Salaries and
// operating expenses are sensitive owner information — never expose to employees.
async function requireOwnerContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Solo el dueño puede gestionar gastos operativos');
  }
  return { userId, orgId };
}

// Validates that a string is a YYYY-MM-DD date.
function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export type CreateExpenseInput = {
  amount: number;
  category: string;
  description?: string | null;
  incurredOn: string; // YYYY-MM-DD
};

export type ExpenseRow = typeof expensesSchema.$inferSelect;

export async function createExpense(
  input: CreateExpenseInput,
): Promise<ActionResult<ExpenseRow>> {
  const { userId, orgId } = await requireOwnerContext();

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a cero' };
  }
  if (!input.category?.trim()) {
    return { ok: false, error: 'La categoría es obligatoria' };
  }
  if (!isValidDate(input.incurredOn)) {
    return { ok: false, error: 'La fecha no es válida (use YYYY-MM-DD)' };
  }

  const [row] = await db
    .insert(expensesSchema)
    .values({
      organizationId: orgId,
      amount: String(input.amount),
      category: input.category.trim(),
      description: input.description?.trim() ?? null,
      incurredOn: input.incurredOn,
      createdBy: userId,
    })
    .returning();

  if (!row) {
    throw new Error('No se pudo guardar el gasto');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'expense.created',
    entityType: 'expense',
    entityId: row.id,
    after: {
      amount: input.amount,
      category: input.category.trim(),
      incurredOn: input.incurredOn,
    },
  });

  revalidatePath('/dashboard/expenses');
  revalidatePath('/dashboard');

  return { ok: true, data: row };
}

export type ListExpensesInput = {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
};

export async function listExpenses(
  input: ListExpensesInput,
): Promise<ExpenseRow[]> {
  const { orgId } = await requireOwnerContext();

  if (!isValidDate(input.start) || !isValidDate(input.end)) {
    throw new Error('Rango de fechas inválido');
  }

  const rows = await db
    .select()
    .from(expensesSchema)
    .where(
      and(
        eq(expensesSchema.organizationId, orgId),
        between(expensesSchema.incurredOn, input.start, input.end),
      ),
    )
    .orderBy(desc(expensesSchema.incurredOn), desc(expensesSchema.createdAt));

  return rows;
}

export type UpdateExpenseInput = {
  amount?: number;
  category?: string;
  description?: string | null;
  incurredOn?: string;
};

export async function updateExpense(
  id: string,
  input: UpdateExpenseInput,
): Promise<ActionResult<ExpenseRow>> {
  const { userId, orgId } = await requireOwnerContext();

  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) {
    return { ok: false, error: 'El monto debe ser mayor a cero' };
  }
  if (input.category !== undefined && !input.category?.trim()) {
    return { ok: false, error: 'La categoría es obligatoria' };
  }
  if (input.incurredOn !== undefined && !isValidDate(input.incurredOn)) {
    return { ok: false, error: 'La fecha no es válida (use YYYY-MM-DD)' };
  }

  const [existing] = await db
    .select()
    .from(expensesSchema)
    .where(
      and(
        eq(expensesSchema.id, id),
        eq(expensesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { ok: false, error: 'Gasto no encontrado' };
  }

  const updates: Partial<typeof expensesSchema.$inferInsert> = {};
  if (input.amount !== undefined) {
    updates.amount = String(input.amount);
  }
  if (input.category !== undefined) {
    updates.category = input.category.trim();
  }
  if (input.description !== undefined) {
    updates.description = input.description?.trim() ?? null;
  }
  if (input.incurredOn !== undefined) {
    updates.incurredOn = input.incurredOn;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: true, data: existing };
  }

  const [updated] = await db
    .update(expensesSchema)
    .set(updates)
    .where(
      and(
        eq(expensesSchema.id, id),
        eq(expensesSchema.organizationId, orgId),
      ),
    )
    .returning();

  if (!updated) {
    return { ok: false, error: 'Gasto no encontrado' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'expense.updated',
    entityType: 'expense',
    entityId: id,
    before: {
      amount: existing.amount,
      category: existing.category,
      incurredOn: existing.incurredOn,
    },
    after: updates,
  });

  revalidatePath('/dashboard/expenses');
  revalidatePath('/dashboard');

  return { ok: true, data: updated };
}

export async function deleteExpense(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireOwnerContext();

  const [existing] = await db
    .select()
    .from(expensesSchema)
    .where(
      and(
        eq(expensesSchema.id, id),
        eq(expensesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { ok: false, error: 'Gasto no encontrado' };
  }

  await db
    .delete(expensesSchema)
    .where(
      and(
        eq(expensesSchema.id, id),
        eq(expensesSchema.organizationId, orgId),
      ),
    );

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'expense.deleted',
    entityType: 'expense',
    entityId: id,
    before: {
      amount: existing.amount,
      category: existing.category,
      incurredOn: existing.incurredOn,
    },
  });

  revalidatePath('/dashboard/expenses');
  revalidatePath('/dashboard');

  return { ok: true, data: { id } };
}
