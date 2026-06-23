import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';
import { movementTypeLabel } from './movementLabels';
import { classifyTimelineDirection } from './utils';

function formatTimelineDate(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/**
 * A single treasury timeline row. Shared by the dashboard "Historial de
 * tesorería" card and the full-history page so both render identically.
 *
 * The icon, color and amount sign follow the company-wide direction:
 *   - neutral (both ends): internal move, ArrowRightLeft, no sign
 *   - in (only destination): money entered, ArrowDownToLine, + success
 *   - out (only source): money left, ArrowUpFromLine, - destructive
 * The title uses the precise movement type (Gasto, Consignación, …) so the
 * full history reads correctly for every type, not just entradas.
 */
export function TimelineRow({ entry }: { entry: TreasuryTimelineEntry }) {
  const direction = classifyTimelineDirection(entry);
  const isMov = direction === 'neutral';
  const isIn = direction === 'in';
  const isOut = direction === 'out';

  const icon = isMov
    ? <ArrowRightLeft className="size-[17px]" />
    : isIn
      ? <ArrowDownToLine className="size-[17px]" />
      : <ArrowUpFromLine className="size-[17px]" />;

  const iconCls = isMov
    ? 'bg-chart-5/10 text-chart-5'
    : isIn
      ? 'bg-success/10 text-success'
      : 'bg-destructive/10 text-destructive';

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
          ${iconCls}
        `}
      >
        {icon}
      </span>

      {/* Label + meta */}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">
          {movementTypeLabel(entry.type)}
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
                  {formatTimelineDate(entry.createdAt)}
                </>
              )
            : (
                <>
                  {entry.toAccount ?? entry.fromAccount}
                  {' '}
                  ·
                  {' '}
                  {formatTimelineDate(entry.createdAt)}
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
      : isOut
        ? 'text-destructive'
        : `text-secondary-foreground`}
        `}
      >
        {isIn ? '+ ' : isOut ? '- ' : ''}
        {money(entry.amount)}
      </div>
    </div>
  );
}
