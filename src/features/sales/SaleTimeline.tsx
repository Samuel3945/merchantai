import type { SaleTimelineEvent, SaleTimelineTone } from '@/actions/sales';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(v: string): string {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? moneyFmt.format(n) : v;
}

// Compact day + time stamp: a sale's lifecycle can span days (a credito paid weeks
// later), so each beat carries its own date, not just the hour.
const stampFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

const toneDot: Record<SaleTimelineTone, string> = {
  neutral: 'border-border bg-background',
  success: 'border-emerald-500 bg-emerald-500',
  warning: 'border-amber-500 bg-amber-500',
  danger: 'border-red-500 bg-red-500',
  eco: 'border-emerald-500 bg-emerald-500',
};

const toneText: Record<SaleTimelineTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  eco: 'text-emerald-600 dark:text-emerald-400',
};

// The audited story of one sale, oldest beat first. Every event is reconstructed
// server-side from the real ledgers (see getSaleTimeline) — this only renders.
export function SaleTimeline({ events }: { events: SaleTimelineEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4 shadow-xs">
      <div className="text-sm font-semibold">Línea de tiempo</div>
      <ol className="relative">
        {events.map((e, i) => (
          <li
            key={e.id}
            className="
              relative flex gap-3 pb-4
              last:pb-0
            "
          >
            {i < events.length - 1 && (
              <span
                className="absolute top-3 bottom-0 left-[5px] w-px bg-border"
                aria-hidden
              />
            )}
            <span
              className={cn(
                'relative z-10 mt-1 size-3 shrink-0 rounded-full border-2',
                toneDot[e.tone],
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium">{e.title}</span>
                {e.amount && (
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {money(e.amount)}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                {e.detail
                  ? (
                      <span className={cn('min-w-0 truncate text-xs', toneText[e.tone])}>
                        {e.detail}
                      </span>
                    )
                  : <span />}
                <span className="
                  shrink-0 text-[11px] text-muted-foreground tabular-nums
                "
                >
                  {stampFmt.format(new Date(e.at))}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
