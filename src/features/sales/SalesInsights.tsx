'use client';

import type { SalesSummary } from '@/actions/sales';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(n: number): string {
  return moneyFmt.format(Number.isFinite(n) ? n : 0);
}

// "14" → "2 p. m." in the same Bogota-clock style the rest of Ventas uses.
function hourLabel(h: number): string {
  const fmt = (x: number) => {
    const norm = ((x % 24) + 24) % 24;
    const hour12 = norm % 12 === 0 ? 12 : norm % 12;
    const mer = norm < 12 ? 'a. m.' : 'p. m.';
    return `${hour12} ${mer}`;
  };
  return `${fmt(h)} – ${fmt(h + 1)}`;
}

// A tiny inline trend line for the headline card. Pure SVG, no deps; it reads
// the per-day totals the summary already computed.
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) {
    return null;
  }
  const w = 150;
  const h = 34;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map(
    (v, i) =>
      [
        (i / (data.length - 1)) * w,
        h - ((v - min) / span) * (h - 5) - 3,
      ] as const,
  );
  const line = pts
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="mt-1 block w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} className="fill-primary/10" />
      <path
        d={line}
        className="fill-none stroke-primary"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.6} className="fill-primary" />
    </svg>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="
      text-[11px] font-medium tracking-wide text-muted-foreground uppercase
    "
    >
      {children}
    </div>
  );
}

function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        `
          flex min-w-0 flex-col gap-1.5 rounded-lg border bg-background p-4
          shadow-xs
        `,
        className,
      )}
    >
      {children}
    </div>
  );
}

// The period insight band above the sales table. Every figure comes from
// getSalesSummary, which aggregates the SAME filtered range the table shows —
// so the cards and the rows always tell the same story.
export function SalesInsights({ summary }: { summary: SalesSummary }) {
  const {
    soldGross,
    salesCount,
    avgTicket,
    refundedTotal,
    refundCount,
    cashPaid,
    digitalPaid,
    peakHour,
    peakHourCount,
    daily,
  } = summary;

  const totalPaid = cashPaid + digitalPaid;
  const pctCash = totalPaid > 0 ? Math.round((cashPaid / totalPaid) * 100) : 0;
  const pctDigital = totalPaid > 0 ? 100 - pctCash : 0;
  const spark = daily.slice(-30).map(d => d.total);

  return (
    <div className="
      grid grid-cols-1 gap-3
      sm:grid-cols-2
      xl:grid-cols-5
    "
    >
      <Card>
        <Eyebrow>Vendido en el rango</Eyebrow>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {money(soldGross)}
        </div>
        <div className="text-xs text-muted-foreground">
          {salesCount}
          {' '}
          {salesCount === 1 ? 'venta' : 'ventas'}
        </div>
        <Sparkline data={spark} />
      </Card>

      <Card>
        <Eyebrow>Ticket promedio</Eyebrow>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {money(avgTicket)}
        </div>
        <div className="text-xs text-muted-foreground">por venta</div>
      </Card>

      <Card>
        <Eyebrow>Devoluciones</Eyebrow>
        <div
          className={cn(
            'text-2xl font-semibold tracking-tight tabular-nums',
            refundedTotal > 0 && `
              text-red-600
              dark:text-red-400
            `,
          )}
        >
          {money(refundedTotal)}
        </div>
        <div className="text-xs text-muted-foreground">
          {refundCount > 0
            ? `${refundCount} ${refundCount === 1 ? 'devolución' : 'devoluciones'}`
            : 'sin devoluciones'}
        </div>
      </Card>

      <Card>
        <Eyebrow>Hora pico</Eyebrow>
        <div className="text-2xl font-semibold tracking-tight">
          {peakHour != null ? hourLabel(peakHour) : '—'}
        </div>
        <div className="text-xs text-muted-foreground">
          {peakHour != null
            ? `${peakHourCount} ${peakHourCount === 1 ? 'venta' : 'ventas'}`
            : 'sin datos en el rango'}
        </div>
      </Card>

      <Card>
        <Eyebrow>Cómo te pagan</Eyebrow>
        <div className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-muted">
          <div
            className="bg-primary"
            style={{ width: `${pctDigital}%` }}
          />
          <div
            className="bg-amber-500"
            style={{ width: `${pctCash}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between gap-3 text-xs">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full bg-primary" />
              Digital ·
              {' '}
              {pctDigital}
              %
            </div>
            <div className="mt-0.5 ml-3.5 text-muted-foreground tabular-nums">
              {money(digitalPaid)}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="flex items-center justify-end gap-1.5">
              <span className="size-2 shrink-0 rounded-full bg-amber-500" />
              Efectivo ·
              {' '}
              {pctCash}
              %
            </div>
            <div className="mt-0.5 text-muted-foreground tabular-nums">
              {money(cashPaid)}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
