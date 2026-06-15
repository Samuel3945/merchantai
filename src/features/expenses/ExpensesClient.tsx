'use client';

import type { ExpenseRow } from '@/actions/expenses';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { useMemo, useState, useTransition } from 'react';
import {
  createExpense,
  deleteExpense,
  listExpenses,
} from '@/actions/expenses';
import { recordGasto } from '@/actions/treasury';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
} from '@/features/expenses/categories';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { CASH_SENTINEL, resolveExpenseSource } from './expenses-routing';

// ── Formatting helpers ──────────────────────────────────────────────────────

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

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

function categoryLabel(cat: string) {
  return EXPENSE_CATEGORY_LABELS[cat] ?? cat;
}

// ── Add expense form ────────────────────────────────────────────────────────

function AddExpenseForm({
  onSuccess,
  treasuryAccounts,
}: {
  onSuccess: () => void;
  treasuryAccounts: TreasuryAccountRow[];
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayBogota());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Treasury source selector:
  // treasuryAccounts that are caja_fuerte or banco can receive gasto outflows.
  const eligibleAccounts = treasuryAccounts.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );

  // Default: CASH_SENTINEL (legacy cash path). When org has exactly one eligible
  // treasury account, auto-select it so there's no extra friction.
  const [fromAccountId, setFromAccountId] = useState<string>(
    eligibleAccounts.length === 1 ? (eligibleAccounts[0]?.id ?? CASH_SENTINEL) : CASH_SENTINEL,
  );

  const isOtros = category === 'otros';
  const showSourceSelector = eligibleAccounts.length > 0;

  const sourceOptions = [
    { value: CASH_SENTINEL, label: 'Efectivo / caja (sin tesorería)' },
    ...eligibleAccounts.map(a => ({
      value: a.id,
      label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
    })),
  ];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = Number.parseFloat(amount.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Ingresa un monto mayor a cero');
      return;
    }
    if (isOtros && !description.trim()) {
      setError('Para la categoría "Otros" debes escribir el motivo del gasto');
      return;
    }

    // Determine routing: treasury dual-write vs. legacy cash path.
    const source = resolveExpenseSource(fromAccountId, CASH_SENTINEL);

    startTransition(async () => {
      if (source.type === 'treasury') {
        // Treasury path: recordGasto inserts both expenses + treasury_movements atomically.
        // Do NOT also call createExpense — that would be a double-write.
        const result = await recordGasto({
          fromAccountId: source.accountId,
          amount: parsed,
          category,
          description: description.trim() || null,
          incurredOn: date,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      } else {
        // Cash path: unchanged legacy behavior.
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
      }

      setAmount('');
      setDescription('');
      setDate(todayBogota());
      // Reset source selector to single-account auto-select or sentinel.
      setFromAccountId(
        eligibleAccounts.length === 1 ? (eligibleAccounts[0]?.id ?? CASH_SENTINEL) : CASH_SENTINEL,
      );
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
        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="expense-amount">
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
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className={labelCls}>Categoría</span>
          <Select
            value={category}
            onValueChange={setCategory}
            options={EXPENSE_CATEGORIES.map(cat => ({
              value: cat,
              label: categoryLabel(cat),
            }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="expense-date">
            Fecha
          </label>
          <input
            id="expense-date"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="expense-description">
            {isOtros ? 'Motivo (obligatorio)' : 'Descripción (opcional)'}
          </label>
          <input
            id="expense-description"
            type="text"
            placeholder={isOtros ? '¿En qué se gastó?' : 'Detalle del gasto'}
            value={description}
            onChange={e => setDescription(e.target.value)}
            required={isOtros}
            className={inputCls}
          />
        </div>
      </div>

      {/* Treasury source selector — only shown when the org has eligible containers */}
      {showSourceSelector && (
        <div className="mt-3 flex flex-col gap-1">
          <span className={labelCls}>¿De dónde sale la plata?</span>
          <Select
            value={fromAccountId}
            onValueChange={setFromAccountId}
            options={sourceOptions}
          />
          {fromAccountId !== CASH_SENTINEL && (
            <p className="text-[11px] text-muted-foreground">
              El gasto se descontará del saldo del contenedor seleccionado.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="
          mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3
          py-2 text-sm text-destructive
        "
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar gasto'}
        </Button>
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
        <p className="text-xs text-destructive">{deleteError}</p>
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

// ── Root component ──────────────────────────────────────────────────────────

export function ExpensesClient({
  initialExpenses,
  defaultStart,
  defaultEnd,
  treasuryAccounts = [],
}: {
  initialExpenses: ExpenseRow[];
  defaultStart: string;
  defaultEnd: string;
  treasuryAccounts?: TreasuryAccountRow[];
}) {
  const [expenses, setExpenses] = useState<ExpenseRow[]>(initialExpenses);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [loading, startTransition] = useTransition();

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  function reload(s: string, e: string) {
    startTransition(async () => {
      const rows = await listExpenses({ start: s, end: e });
      setExpenses(rows);
    });
  }

  function handleAddSuccess() {
    reload(start, end);
  }

  function handleDelete(id: string) {
    setExpenses(prev => prev.filter(r => r.id !== id));
  }

  // Category filter applies in memory: the period query already returns the
  // full window and expense volumes are small.
  const visibleExpenses = categoryFilter
    ? expenses.filter(e => e.category === categoryFilter)
    : expenses;

  return (
    <div className="space-y-6">
      <AddExpenseForm
        onSuccess={handleAddSuccess}
        treasuryAccounts={treasuryAccounts}
      />

      {/* Filter bar — same pattern as Ventas and the report details */}
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="
          grid grid-cols-1 gap-3
          sm:grid-cols-2
          lg:grid-cols-4
        "
        >
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Periodo</span>
            <DateRangePicker
              start={start}
              end={end}
              compare={false}
              showCompare={false}
              activePreset={activePreset}
              presets={presetOptions}
              maxDate={todayBogota()}
              onApply={(next) => {
                setStart(next.start);
                setEnd(next.end);
                setActivePreset(next.preset);
                reload(next.start, next.end);
              }}
              triggerClassName="w-full"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Categoría</span>
            <Select
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              options={[
                { value: '', label: 'Todas las categorías' },
                ...EXPENSE_CATEGORIES.map(cat => ({
                  value: cat,
                  label: categoryLabel(cat),
                })),
              ]}
            />
          </div>
        </div>
        {loading && (
          <p className="text-xs text-muted-foreground">Actualizando…</p>
        )}
      </div>

      <ExpensesTable
        expenses={visibleExpenses}
        onDelete={handleDelete}
      />
    </div>
  );
}
