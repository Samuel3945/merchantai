'use client';

import type { ExpenseRow } from '@/actions/expenses';
import { useState, useTransition } from 'react';
import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORIES,
  listExpenses,
} from '@/actions/expenses';
// ── Formatting helpers ──────────────────────────────────────────────────────

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatMoney(v: string | number) {
  return moneyFmt.format(typeof v === 'string' ? Number.parseFloat(v) : v);
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return iso;
  }
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// ── Category label map ──────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  servicios: 'Servicios',
  arriendo: 'Arriendo',
  transporte: 'Transporte',
  marketing: 'Marketing',
  impuestos: 'Impuestos',
  otros: 'Otros',
};

function categoryLabel(cat: string) {
  return CATEGORY_LABELS[cat] ?? cat;
}

// ── Add expense form ────────────────────────────────────────────────────────

function AddExpenseForm({ onSuccess }: { onSuccess: () => void }) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = Number.parseFloat(amount.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Ingresá un monto mayor a cero');
      return;
    }

    startTransition(async () => {
      const result = await createExpense({
        amount: parsed,
        category,
        description: description.trim() || null,
        incurredOn: date,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAmount('');
      setDescription('');
      setDate(todayIso());
      onSuccess();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border bg-background p-4 shadow-xs"
    >
      <h2 className="mb-4 text-sm font-semibold">Agregar gasto</h2>

      <div className="
        grid gap-3
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        {/* Amount */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="expense-amount">
            Monto
          </label>
          <input
            id="expense-amount"
            type="text"
            inputMode="decimal"
            placeholder="50000"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            required
            className="
              rounded-md border bg-background px-3 py-1.5 text-sm
              focus:ring-2 focus:ring-ring focus:outline-none
            "
          />
        </div>

        {/* Category */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="expense-category">
            Categoría
          </label>
          <select
            id="expense-category"
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="
              rounded-md border bg-background px-3 py-1.5 text-sm
              focus:ring-2 focus:ring-ring focus:outline-none
            "
          >
            {EXPENSE_CATEGORIES.map(cat => (
              <option key={cat} value={cat}>
                {categoryLabel(cat)}
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="expense-date">
            Fecha
          </label>
          <input
            id="expense-date"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className="
              rounded-md border bg-background px-3 py-1.5 text-sm
              focus:ring-2 focus:ring-ring focus:outline-none
            "
          />
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="expense-description">
            Descripción (opcional)
          </label>
          <input
            id="expense-description"
            type="text"
            placeholder="Detalle del gasto"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="
              rounded-md border bg-background px-3 py-1.5 text-sm
              focus:ring-2 focus:ring-ring focus:outline-none
            "
          />
        </div>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="
            rounded-md bg-primary px-4 py-1.5 text-sm font-medium
            text-primary-foreground
            hover:bg-primary/90
            disabled:opacity-50
          "
        >
          {pending ? 'Guardando…' : 'Guardar gasto'}
        </button>
      </div>
    </form>
  );
}

// ── Expenses table ──────────────────────────────────────────────────────────

function ExpensesTable({
  expenses,
  onDelete,
}: {
  expenses: ExpenseRow[];
  onDelete: (id: string) => void;
}) {
  // Two-click confirmation: first click sets confirmId, second click deletes.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleDelete(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      setDeleteError(null);
      return;
    }
    setConfirmId(null);
    setDeletingId(id);
    startTransition(async () => {
      const result = await deleteExpense(id);
      setDeletingId(null);
      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }
      onDelete(id);
    });
  }

  if (expenses.length === 0) {
    return (
      <div className="
        rounded-lg border bg-background p-8 text-center text-sm
        text-muted-foreground
      "
      >
        No hay gastos registrados para este período.
      </div>
    );
  }

  const total = expenses.reduce((sum, e) => sum + Number.parseFloat(e.amount), 0);

  return (
    <div className="space-y-2">
      {deleteError && (
        <p className="text-xs text-red-600">{deleteError}</p>
      )}
      <div className="overflow-hidden rounded-lg border bg-background shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="
                  px-4 py-2.5 text-left text-xs font-medium
                  text-muted-foreground
                "
                >
                  Fecha
                </th>
                <th className="
                  px-4 py-2.5 text-left text-xs font-medium
                  text-muted-foreground
                "
                >
                  Categoría
                </th>
                <th className="
                  px-4 py-2.5 text-left text-xs font-medium
                  text-muted-foreground
                "
                >
                  Descripción
                </th>
                <th className="
                  px-4 py-2.5 text-right text-xs font-medium
                  text-muted-foreground
                "
                >
                  Monto
                </th>
                <th className="
                  px-4 py-2.5 text-right text-xs font-medium
                  text-muted-foreground
                "
                >
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {expenses.map(expense => (
                <tr key={expense.id} className="hover:bg-muted/20">
                  <td className="
                    px-4 py-2.5 text-xs text-muted-foreground tabular-nums
                  "
                  >
                    {formatDate(expense.incurredOn)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="
                      rounded-full bg-secondary px-2 py-0.5 text-xs font-medium
                    "
                    >
                      {categoryLabel(expense.category)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {expense.description ?? '—'}
                  </td>
                  <td className="
                    px-4 py-2.5 text-right text-xs font-medium tabular-nums
                  "
                  >
                    {formatMoney(expense.amount)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={deletingId === expense.id}
                      onClick={() => handleDelete(expense.id)}
                      className="
                        text-xs
                        hover:underline
                        disabled:opacity-50
                      "
                      aria-label={confirmId === expense.id ? 'Confirmar eliminación' : 'Eliminar gasto'}
                    >
                      {deletingId === expense.id
                        ? '…'
                        : confirmId === expense.id
                          ? '¿Confirmar?'
                          : 'Eliminar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30">
              <tr>
                <td colSpan={3} className="px-4 py-2 text-xs font-semibold">
                  Total del período
                </td>
                <td className="
                  px-4 py-2 text-right text-xs font-semibold tabular-nums
                "
                >
                  {formatMoney(total)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Period picker ───────────────────────────────────────────────────────────

function PeriodPicker({
  start,
  end,
  onApply,
}: {
  start: string;
  end: string;
  onApply: (start: string, end: string) => void;
}) {
  const [s, setS] = useState(start);
  const [e, setE] = useState(end);

  function handleApply(ev: React.FormEvent) {
    ev.preventDefault();
    onApply(s, e);
  }

  return (
    <form onSubmit={handleApply} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="period-start">
          Desde
        </label>
        <input
          id="period-start"
          type="date"
          value={s}
          max={e}
          onChange={ev => setS(ev.target.value)}
          className="
            rounded-md border bg-background px-3 py-1.5 text-sm
            focus:ring-2 focus:ring-ring focus:outline-none
          "
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="period-end">
          Hasta
        </label>
        <input
          id="period-end"
          type="date"
          value={e}
          min={s}
          onChange={ev => setE(ev.target.value)}
          className="
            rounded-md border bg-background px-3 py-1.5 text-sm
            focus:ring-2 focus:ring-ring focus:outline-none
          "
        />
      </div>
      <button
        type="submit"
        className="
          rounded-md border px-3 py-1.5 text-sm font-medium
          hover:bg-muted/50
        "
      >
        Filtrar
      </button>
    </form>
  );
}

// ── Root component ──────────────────────────────────────────────────────────

export function ExpensesClient({
  initialExpenses,
  defaultStart,
  defaultEnd,
}: {
  initialExpenses: ExpenseRow[];
  defaultStart: string;
  defaultEnd: string;
}) {
  const [expenses, setExpenses] = useState<ExpenseRow[]>(initialExpenses);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [loading, startTransition] = useTransition();

  function reload(s: string, e: string) {
    startTransition(async () => {
      const rows = await listExpenses({ start: s, end: e });
      setExpenses(rows);
    });
  }

  function handlePeriodChange(s: string, e: string) {
    setStart(s);
    setEnd(e);
    reload(s, e);
  }

  function handleAddSuccess() {
    reload(start, end);
  }

  function handleDelete(id: string) {
    setExpenses(prev => prev.filter(r => r.id !== id));
  }

  return (
    <div className="space-y-6">
      <AddExpenseForm onSuccess={handleAddSuccess} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <PeriodPicker start={start} end={end} onApply={handlePeriodChange} />
        {loading && (
          <p className="self-end text-xs text-muted-foreground">Actualizando…</p>
        )}
      </div>

      <ExpensesTable
        expenses={expenses}
        onDelete={handleDelete}
      />
    </div>
  );
}
