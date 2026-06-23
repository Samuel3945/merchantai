'use client';

import type { GastoRow } from '@/libs/gastos';
import { ChevronDown, ChevronUp, Receipt, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { correctGastoAction, listGastosAction } from '@/actions/treasury';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Select } from '@/components/ui/select';
import { money } from '@/features/cash/cash-ui';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
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

// A correction row (negative amount) cannot itself be corrected — that would
// be a correction of a correction, which is out of scope for v1.
function isCorrectionRow(row: GastoRow): boolean {
  return Number.parseFloat(row.amount) < 0;
}

type GastoRowItemProps = {
  row: GastoRow;
  onCorrect: (id: string) => void;
  correcting: boolean;
};

function GastoRowItem({ row, onCorrect, correcting }: GastoRowItemProps) {
  const isReversal = isCorrectionRow(row);
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
          <span className={`
            text-[13.5px] font-semibold
            ${isReversal
      ? `text-muted-foreground line-through`
      : ''}
          `}
          >
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
          {isReversal && (
            <span className="
              rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold
              text-muted-foreground
            "
            >
              Corregido
            </span>
          )}
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
      <div className="flex items-center gap-2">
        {!isReversal && (
          <button
            type="button"
            onClick={() => onCorrect(row.id)}
            disabled={correcting}
            title="Corregir gasto (reversión referenciada)"
            className="
              flex size-7 shrink-0 items-center justify-center rounded-md
              text-muted-foreground transition-colors
              hover:bg-muted hover:text-foreground
              disabled:cursor-not-allowed disabled:opacity-40
            "
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
        <div className={`
          font-display text-[14.5px] font-[650] tabular-nums
          ${isReversal ? 'text-emerald-600' : 'text-destructive'}
        `}
        >
          {isReversal ? '+' : '-'}
          {' '}
          {money(Math.abs(Number.parseFloat(row.amount)).toFixed(2))}
        </div>
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
  const [rows, setRows] = useState<GastoRow[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  // Initial range is the current calendar month, i.e. the "Este mes" preset.
  const [activePreset, setActivePreset] = useState<string | null>('mtd');
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [correctingId, setCorrectingId] = useState<string | null>(null);

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

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

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setStart(next.start);
    setEnd(next.end);
    setActivePreset(next.preset);
    fetchGastos(next.start, next.end, category);
  }

  function onCategoryChange(val: string) {
    setCategory(val);
    fetchGastos(start, end, val);
  }

  const onCorrect = useCallback(
    (expenseId: string) => {
      setCorrectingId(expenseId);
      startTransition(async () => {
        const result = await correctGastoAction(expenseId);
        setCorrectingId(null);
        if (result.ok) {
          // Refresh the list to show the reversal row.
          fetchGastos(start, end, category);
        }
      });
    },
    [start, end, category, fetchGastos],
  );

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
          {/* Filters — shared styled controls */}
          <div className="
            mt-4 grid gap-3
            sm:grid-cols-2
          "
          >
            <div className="text-xs">
              <span className="mb-1 block text-muted-foreground">Periodo</span>
              <DateRangePicker
                start={start}
                end={end}
                compare={false}
                showCompare={false}
                activePreset={activePreset}
                presets={presetOptions}
                maxDate={todayBogota()}
                onApply={applyRange}
                triggerClassName="w-full"
              />
            </div>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Categoría</span>
              <Select
                value={category}
                onValueChange={onCategoryChange}
                options={categoryOptions}
                placeholder="Todas"
              />
            </label>
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
                    <GastoRowItem
                      key={row.id}
                      row={row}
                      onCorrect={onCorrect}
                      correcting={correctingId === row.id}
                    />
                  ))}
                </div>
              )}
        </>
      )}
    </div>
  );
}
