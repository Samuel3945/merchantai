'use client';

import type { GastoRow } from '@/libs/gastos';
import { ChevronDown, ChevronUp, Receipt } from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import { listGastosAction } from '@/actions/treasury';
import { Select } from '@/components/ui/select';
import { cashInputCls, money } from '@/features/cash/cash-ui';
import {
  TREASURY_EXPENSE_CATEGORIES,
  TREASURY_EXPENSE_CATEGORY_LABELS,
} from './expenseCategories';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  // incurredOn is a YYYY-MM-DD string from the date column
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

function originLabel(origin: GastoRow['origin']): string {
  switch (origin) {
    case 'treasury': return 'Tesorería';
    case 'pos': return 'Caja POS';
    case 'legacy': return 'Manual';
  }
}

function originColor(origin: GastoRow['origin']): string {
  switch (origin) {
    case 'treasury': return 'bg-chart-5/10 text-chart-5';
    case 'pos': return 'bg-primary/10 text-primary';
    case 'legacy': return 'bg-muted text-muted-foreground';
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function GastoRowItem({ row }: { row: GastoRow }) {
  return (
    <div className="
      flex items-center gap-3.5 rounded-xl px-4 py-3.5 transition-colors
      hover:bg-muted
    "
    >
      <span className="
        flex size-9 shrink-0 items-center justify-center rounded-[10px]
        bg-destructive/10 text-destructive
      "
      >
        <Receipt className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold">
            {TREASURY_EXPENSE_CATEGORY_LABELS[row.category as keyof typeof TREASURY_EXPENSE_CATEGORY_LABELS]
              ?? row.category}
          </span>
          <span className={`
            rounded-sm px-1.5 py-0.5 text-[10px] font-semibold
            ${originColor(row.origin)}
          `}
          >
            {originLabel(row.origin)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {formatDate(row.incurredOn)}
          {row.description && (
            <>
              {' · '}
              {row.description}
            </>
          )}
        </div>
      </div>
      <div className="
        font-display text-[14.5px] font-[650] text-destructive tabular-nums
      "
      >
        -
        {' '}
        {money(row.amount)}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

type GastosHistoryProps = {
  initialRows: GastoRow[];
  initialTotal: number;
  initialStart: string;
  initialEnd: string;
};

/**
 * Unified gastos history: shows all gastos from treasury, POS, and legacy
 * origins. Supports date-range and category filters. Reads the expenses table
 * exclusively — does NOT depend on actions/expenses.ts (deleted in Slice 3).
 */
export function GastosHistory({
  initialRows,
  initialTotal,
  initialStart,
  initialEnd,
}: GastosHistoryProps) {
  const today = new Date().toISOString().slice(0, 10);

  const [rows, setRows] = useState<GastoRow[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [isPending, startTransition] = useTransition();

  const categoryOptions = [
    { value: '', label: 'Todas las categorías' },
    ...TREASURY_EXPENSE_CATEGORIES.map(cat => ({
      value: cat,
      label: TREASURY_EXPENSE_CATEGORY_LABELS[cat],
    })),
  ];

  const fetchGastos = useCallback(
    (s: string, e: string, cat: string) => {
      startTransition(async () => {
        const result = await listGastosAction({
          start: s,
          end: e,
          category: cat || undefined,
        });
        setRows(result.rows);
        setTotal(result.total);
      });
    },
    [],
  );

  function onStartChange(val: string) {
    setStart(val);
    if (val && end) {
      fetchGastos(val, end, category);
    }
  }

  function onEndChange(val: string) {
    setEnd(val);
    if (start && val) {
      fetchGastos(start, val, category);
    }
  }

  function onCategoryChange(val: string) {
    setCategory(val);
    fetchGastos(start, end, val);
  }

  return (
    <div className="rounded-xl border border-border bg-card p-[18px] shadow-xs">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">
            Historial de gastos
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Gastos de tesorería, caja POS y registros anteriores.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="
            flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs
            font-medium text-muted-foreground
            hover:bg-muted hover:text-foreground
          "
          aria-label={expanded ? 'Colapsar historial' : 'Expandir historial'}
        >
          {expanded
            ? <ChevronUp className="size-3.5" />
            : (
                <ChevronDown className="size-3.5" />
              )}
        </button>
      </div>

      {expanded && (
        <>
          {/* Filters */}
          <div className="mt-4 flex flex-wrap gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Desde</label>
              <input
                type="date"
                value={start}
                max={end || today}
                onChange={e => onStartChange(e.target.value)}
                className={`
                  ${cashInputCls}
                  h-9 text-sm
                `}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Hasta</label>
              <input
                type="date"
                value={end}
                min={start}
                max={today}
                onChange={e => onEndChange(e.target.value)}
                className={`
                  ${cashInputCls}
                  h-9 text-sm
                `}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Categoría</label>
              <Select
                value={category}
                onValueChange={onCategoryChange}
                options={categoryOptions}
                placeholder="Todas"
              />
            </div>
          </div>

          {/* Total bar */}
          <div className="
            mt-3 flex items-center justify-between rounded-lg bg-muted/50 px-4
            py-2.5
          "
          >
            <span className="text-[13px] text-muted-foreground">
              {isPending ? 'Cargando…' : `${rows.length} gasto${rows.length !== 1 ? 's' : ''}`}
            </span>
            <span className="
              font-display text-[15px] font-[650] text-destructive tabular-nums
            "
            >
              -
              {' '}
              {money(total)}
            </span>
          </div>

          {/* Rows */}
          {rows.length === 0
            ? (
                <p className="
                  mt-4 text-center text-[13px] text-muted-foreground
                "
                >
                  No hay gastos en el período seleccionado.
                </p>
              )
            : (
                <div className="mt-2 flex flex-col">
                  {rows.map(row => (
                    <GastoRowItem key={row.id} row={row} />
                  ))}
                </div>
              )}
        </>
      )}
    </div>
  );
}
