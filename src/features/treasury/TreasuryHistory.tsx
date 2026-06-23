import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ChevronRight } from 'lucide-react';
import { Link } from '@/libs/I18nNavigation';
import { TimelineRow } from './TimelineRow';

type TreasuryHistoryProps = {
  entries: TreasuryTimelineEntry[];
  /** Max rows to display (defaults to 7 — matches design preview) */
  maxRows?: number;
};

/**
 * "Historial de tesorería" section.
 * Shows recent treasury movements via the shared TimelineRow. "Ver todo" links
 * to the full-history page (/dashboard/tesoreria/historial) with filters.
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
        <Link
          href="/dashboard/tesoreria/historial"
          className="
            flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs
            font-medium text-muted-foreground
            hover:bg-muted hover:text-foreground
          "
          aria-label="Ver todo el historial"
        >
          Ver todo
          <ChevronRight className="size-3.5" />
        </Link>
      </div>

      {/* Rows */}
      <div className="mt-2 flex flex-col">
        {visible.map(entry => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
