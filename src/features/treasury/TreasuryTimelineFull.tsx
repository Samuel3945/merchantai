'use client';

import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { getTimelinePage } from '@/actions/treasury';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Select } from '@/components/ui/select';
import { Link } from '@/libs/I18nNavigation';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import {
  TREASURY_MOVEMENT_TYPE_LABELS,
  TREASURY_MOVEMENT_TYPES,
} from './movementLabels';
import { TimelineRow } from './TimelineRow';

type AccountOption = { id: string; name: string };

type Filters = {
  start: string;
  end: string;
  type: string;
  accountId: string;
};

type TreasuryTimelineFullProps = {
  initialRows: TreasuryTimelineEntry[];
  initialTotal: number;
  pageSize: number;
  accounts: AccountOption[];
};

/**
 * Full treasury history page: the complete movement timeline with date-range,
 * type and account filters plus "Cargar más" pagination. Reached from the
 * dashboard "Historial de tesorería" card's "Ver todo" link.
 *
 * Uses the app's shared DateRangePicker + styled filter band (same as cash
 * closures / sales / dashboard) so the controls match the rest of the product.
 * Changing any filter resets to page 1 and replaces the list; "Cargar más"
 * fetches the next page and appends. The server action owns gating and clamps
 * page size — this component only drives the query.
 */
export function TreasuryTimelineFull({
  initialRows,
  initialTotal,
  pageSize,
  accounts,
}: TreasuryTimelineFullProps) {
  const [rows, setRows] = useState<TreasuryTimelineEntry[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({
    start: '',
    end: '',
    type: '',
    accountId: '',
  });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  const typeOptions = [
    { value: '', label: 'Todos los tipos' },
    ...TREASURY_MOVEMENT_TYPES.map(t => ({
      value: t,
      label: TREASURY_MOVEMENT_TYPE_LABELS[t]!,
    })),
  ];

  const accountOptions = [
    { value: '', label: 'Todas las cuentas' },
    ...accounts.map(a => ({ value: a.id, label: a.name })),
  ];

  // Re-query from page 1 with the given filters and replace the list.
  const applyFilters = useCallback(
    (next: Filters) => {
      setFilters(next);
      startTransition(async () => {
        const result = await getTimelinePage({
          start: next.start || undefined,
          end: next.end || undefined,
          type: next.type || undefined,
          accountId: next.accountId || undefined,
          page: 1,
          pageSize,
        });
        setRows(result.rows);
        setTotal(result.total);
        setPage(1);
      });
    },
    [pageSize],
  );

  // Fetch the next page and append.
  const loadMore = useCallback(() => {
    const nextPage = page + 1;
    startTransition(async () => {
      const result = await getTimelinePage({
        start: filters.start || undefined,
        end: filters.end || undefined,
        type: filters.type || undefined,
        accountId: filters.accountId || undefined,
        page: nextPage,
        pageSize,
      });
      setRows(prev => [...prev, ...result.rows]);
      setTotal(result.total);
      setPage(nextPage);
    });
  }, [page, filters, pageSize]);

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setActivePreset(next.preset);
    applyFilters({ ...filters, start: next.start, end: next.end });
  }

  function clearRange() {
    setActivePreset(null);
    applyFilters({ ...filters, start: '', end: '' });
  }

  const clearFilters = useCallback(() => {
    setActivePreset(null);
    applyFilters({ start: '', end: '', type: '', accountId: '' });
  }, [applyFilters]);

  const hasMore = rows.length < total;
  const hasActiveFilters
    = filters.start !== ''
      || filters.end !== ''
      || filters.type !== ''
      || filters.accountId !== '';

  return (
    <div className="flex flex-col gap-[22px]">
      {/* Back link */}
      <Link
        href="/dashboard/tesoreria"
        className="
          flex w-fit items-center gap-1.5 text-[13px] font-medium
          text-muted-foreground transition-colors
          hover:text-foreground
        "
      >
        <ArrowLeft className="size-4" />
        Volver a Tesorería
      </Link>

      <div className="rounded-xl border border-border bg-card shadow-xs">
        {/* Header */}
        <div className="
          flex flex-col gap-1 border-b border-border px-5 py-3
          sm:flex-row sm:items-center sm:justify-between
        "
        >
          <div>
            <h1 className="text-sm font-semibold">Historial de tesorería</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Todos los movimientos, del más nuevo al más antiguo.
            </p>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="
                self-start text-xs font-medium text-primary
                hover:underline
                sm:self-auto
              "
            >
              Limpiar filtros
            </button>
          )}
        </div>

        {/* Filters — shared styled controls */}
        <div className="
          grid gap-3 border-b border-border bg-muted/30 p-3
          sm:grid-cols-2
          lg:grid-cols-3
        "
        >
          <div className="text-xs">
            <span className="mb-1 block text-muted-foreground">Periodo</span>
            <DateRangePicker
              start={filters.start}
              end={filters.end}
              compare={false}
              showCompare={false}
              activePreset={activePreset}
              presets={presetOptions}
              maxDate={todayBogota()}
              onApply={applyRange}
              onClear={clearRange}
              triggerClassName="w-full"
            />
          </div>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Tipo</span>
            <Select
              value={filters.type}
              onValueChange={v => applyFilters({ ...filters, type: v })}
              options={typeOptions}
              placeholder="Todos"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Cuenta</span>
            <Select
              value={filters.accountId}
              onValueChange={v => applyFilters({ ...filters, accountId: v })}
              options={accountOptions}
              placeholder="Todas"
            />
          </label>
        </div>

        {/* Body */}
        <div className="p-3">
          <div className="px-1 pb-1">
            <span className="text-[13px] text-muted-foreground">
              {isPending
                ? 'Cargando…'
                : `${total} movimiento${total !== 1 ? 's' : ''}`}
            </span>
          </div>

          {rows.length === 0
            ? (
                <p className="
                  py-6 text-center text-[13px] text-muted-foreground
                "
                >
                  No hay movimientos con los filtros seleccionados.
                </p>
              )
            : (
                <>
                  <div className="flex flex-col">
                    {rows.map(entry => (
                      <TimelineRow key={entry.id} entry={entry} />
                    ))}
                  </div>

                  {hasMore && (
                    <div className="mt-3 flex justify-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={isPending}
                        className="
                          rounded-md border border-border px-4 py-2 text-[13px]
                          font-medium text-foreground transition-colors
                          hover:bg-muted
                          disabled:cursor-not-allowed disabled:opacity-40
                        "
                      >
                        {isPending ? 'Cargando…' : 'Cargar más'}
                      </button>
                    </div>
                  )}
                </>
              )}
        </div>
      </div>
    </div>
  );
}
