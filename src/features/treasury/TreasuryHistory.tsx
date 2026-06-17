'use client';

import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ArrowDownToLine, ArrowRightLeft, ChevronRight } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';
import { classifyTimelineDirection } from './utils';

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function HistoryRow({ entry }: { entry: TreasuryTimelineEntry }) {
  const direction = classifyTimelineDirection(entry);
  const isMov = entry.fromAccount !== null && entry.toAccount !== null;
  const isIn = direction === 'in';

  return (
    <div
      className="
        flex items-center gap-3.5 rounded-xl px-4 py-3.5 transition-colors
        hover:bg-muted
      "
    >
      {/* Icon */}
      <span
        className={`
          flex size-9 shrink-0 items-center justify-center rounded-[10px]
          ${isMov ? 'bg-chart-5/10 text-chart-5' : 'bg-success/10 text-success'}
        `}
      >
        {isMov
          ? <ArrowRightLeft className="size-[17px]" />
          : <ArrowDownToLine className="size-[17px]" />}
      </span>

      {/* Label + meta */}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">
          {isMov ? 'Movimiento interno' : 'Entrada'}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {isMov
            ? (
                <>
                  {entry.fromAccount}
                  {' '}
                  <span className="opacity-60">→</span>
                  {' '}
                  {entry.toAccount}
                  {' '}
                  ·
                  {' '}
                  {formatDate(entry.createdAt)}
                </>
              )
            : (
                <>
                  {entry.toAccount ?? entry.fromAccount}
                  {' '}
                  ·
                  {' '}
                  {formatDate(entry.createdAt)}
                </>
              )}
        </div>
      </div>

      {/* Amount */}
      <div
        className={`
          font-display text-[14.5px] font-[650] tabular-nums
          ${isIn
      ? 'text-success'
      : isMov
        ? 'text-secondary-foreground'
        : `text-destructive`}
        `}
      >
        {isIn ? '+ ' : ''}
        {money(entry.amount)}
      </div>
    </div>
  );
}

type TreasuryHistoryProps = {
  entries: TreasuryTimelineEntry[];
  /** Max rows to display (defaults to 7 — matches design preview) */
  maxRows?: number;
};

/**
 * "Historial de tesorería" section.
 * Shows recent treasury movements: Entrada (success, ArrowDownToLine icon) and
 * Movimiento interno (chart-5/info, ArrowRightLeft icon). Matches View B HistoryPanel.
 * "Ver todo" affordance is a no-op for slice A.
 */
export function TreasuryHistory({ entries, maxRows = 7 }: TreasuryHistoryProps) {
  const visible = entries.slice(0, maxRows);

  if (entries.length === 0) {
    return (
      <div className="
        rounded-xl border border-border bg-card p-[18px] shadow-xs
      "
      >
        <h2 className="text-[17px] font-semibold tracking-tight">
          Historial de tesorería
        </h2>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Todavía no hay movimientos de tesorería registrados.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-[18px] shadow-xs">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">
            Historial de tesorería
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Movimientos recientes, del más nuevo al más antiguo.
          </p>
        </div>
        <button
          type="button"
          className="
            flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs
            font-medium text-muted-foreground
            hover:bg-muted hover:text-foreground
          "
          aria-label="Ver todo el historial"
        >
          Ver todo
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      {/* Rows */}
      <div className="mt-2 flex flex-col">
        {visible.map(entry => (
          <HistoryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
