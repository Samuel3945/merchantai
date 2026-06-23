'use client';

import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import { getTimelinePage } from '@/actions/treasury';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import { Link } from '@/libs/I18nNavigation';
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
  const today = new Date().toISOString().slice(0, 10);

  const [rows, setRows] = useState<TreasuryTimelineEntry[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({
    start: '',
    end: '',
    type: '',
    accountId: '',
  });
  const [isPending, startTransition] = useTransition();

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

  const hasMore = rows.length < total;

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

      <div className="
        rounded-xl border border-border bg-card p-[18px] shadow-xs
      "
      >
        {/* Header */}
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">
            Historial de tesorería
          </h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Todos los movimientos, del más nuevo al más antiguo.
          </p>
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Desde</label>
            <input
              type="date"
              value={filters.start}
              max={filters.end || today}
              onChange={e => applyFilters({ ...filters, start: e.target.value })}
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
              value={filters.end}
              min={filters.start}
              max={today}
              onChange={e => applyFilters({ ...filters, end: e.target.value })}
              className={`
                ${cashInputCls}
                h-9 text-sm
              `}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Tipo</label>
            <Select
              value={filters.type}
              onValueChange={v => applyFilters({ ...filters, type: v })}
              options={typeOptions}
              placeholder="Todos"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Cuenta</label>
            <Select
              value={filters.accountId}
              onValueChange={v => applyFilters({ ...filters, accountId: v })}
              options={accountOptions}
              placeholder="Todas"
            />
          </div>
        </div>

        {/* Count bar */}
        <div className="
          mt-3 flex items-center justify-between rounded-lg bg-muted/50 px-4
          py-2.5
        "
        >
          <span className="text-[13px] text-muted-foreground">
            {isPending
              ? 'Cargando…'
              : `${total} movimiento${total !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Rows */}
        {rows.length === 0
          ? (
              <p className="mt-4 text-center text-[13px] text-muted-foreground">
                No hay movimientos con los filtros seleccionados.
              </p>
            )
          : (
              <>
                <div className="mt-2 flex flex-col">
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
  );
}
