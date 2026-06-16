'use client';

import type { TreasuryTimelineEntry } from '@/libs/treasury';
import { ArrowRight, Clock } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';

// Human-readable label per movement type.
const TYPE_LABELS: Record<string, string> = {
  transfer: 'Transferencia interna',
  consignacion: 'Consignación',
  entrada: 'Entrada',
  salida: 'Salida',
  gasto: 'Gasto',
  adjustment: 'Ajuste',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function TimelineRow({ entry }: { entry: TreasuryTimelineEntry }) {
  // Expenses (gasto) are negative outflows from the source container.
  const isOutflow = entry.type === 'gasto' || entry.type === 'salida';

  return (
    <div className="
      flex items-start gap-3 border-b border-border py-3
      last:border-0
    "
    >
      <div className="
        mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full
        bg-muted
      "
      >
        <Clock className="size-3.5 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{typeLabel(entry.type)}</span>
          <span
            className={`
              font-display text-sm font-semibold tabular-nums
              ${isOutflow ? 'text-destructive' : 'text-foreground'}
            `}
          >
            {isOutflow ? '−' : '+'}
            {money(entry.amount)}
          </span>
        </div>

        {/* Origin → Destination */}
        <div className="
          mt-0.5 flex items-center gap-1 text-xs text-muted-foreground
        "
        >
          {entry.fromAccount && (
            <span className="max-w-[120px] truncate">{entry.fromAccount}</span>
          )}
          {entry.fromAccount && entry.toAccount && (
            <ArrowRight className="size-3 shrink-0" />
          )}
          {entry.toAccount && (
            <span className="max-w-[120px] truncate">{entry.toAccount}</span>
          )}
          {!entry.fromAccount && !entry.toAccount && (
            <span>—</span>
          )}
        </div>

        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatDate(entry.createdAt)}
        </div>
      </div>
    </div>
  );
}

/**
 * TreasuryTimeline — read-only chronological list of treasury movements.
 * Each entry shows: tipo, timestamp, origen → destino, and signed amount.
 * No edit or delete actions are provided (spec: read-only).
 */
export function TreasuryTimeline({
  entries,
}: {
  entries: TreasuryTimelineEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
        <div className="text-sm font-semibold">Historial de tesorería</div>
        <p className="mt-2 text-xs text-muted-foreground">
          Todavía no hay movimientos de tesorería registrados.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="text-sm font-semibold">Historial de tesorería</div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Movimientos recientes de tesorería, del más nuevo al más antiguo.
      </p>

      <div className="mt-4 divide-y divide-border">
        {entries.map(entry => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
