'use client';

import type { DashboardMetrics, LowStockRow } from '@/actions/dashboard';
import type { FiadosOverview } from '@/libs/fiados';
import type { RangePreset } from '@/utils/DateRange';
import { MessageCircle } from 'lucide-react';
import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getMetrics } from '@/actions/dashboard';
import { DateRangePicker } from '@/components/DateRangePicker';
import {
  buildPresetOptions,
  computePreviousRange,
  todayBogota,
} from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const compactFmt = new Intl.NumberFormat('es-CO', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const percentFmt = new Intl.NumberFormat('es-CO', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const dayFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  timeZone: 'America/Bogota',
});

const rangeFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatRangeLabel(start: string, end: string): string {
  const toLocal = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  if (start === end) {
    return rangeFmt.format(toLocal(start));
  }
  return `${rangeFmt.format(toLocal(start))} – ${rangeFmt.format(toLocal(end))}`;
}

function formatMoney(value: number) {
  return moneyFmt.format(value);
}

function formatDelta(current: number, previous: number) {
  if (previous === 0) {
    return current > 0 ? '—' : '0%';
  }
  const delta = (current - previous) / previous;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${percentFmt.format(delta)}`;
}

// Direction of a delta for the KPI badge: true = improved, false = worsened,
// null = flat (rendered as a neutral chip, no arrow).
function deltaUp(current: number, previous: number, invert = false): boolean | null {
  if (current === previous) {
    return null;
  }
  return invert ? current < previous : current > previous;
}

function formatDayLabel(day: string) {
  if (!day) {
    return '';
  }
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) {
    return day;
  }
  return dayFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Hero KPI. Big number first, one supporting line (delta vs the comparison
 * period or a plain hint). This is the "glance every morning" tier — kept to a
 * handful on purpose; the deep breakdowns live in Reportes.
 */
function KpiCard({
  title,
  value,
  hint,
  delta,
  deltaPositive,
  selected,
  onSelect,
}: {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaPositive?: boolean | null;
  // When `selected`, the card is the one driving the chart below. `onSelect`
  // makes it interactive; without it the card is a plain stat (e.g. Flujo, which
  // has no daily series to chart).
  selected?: boolean;
  onSelect?: () => void;
}) {
  const cardClass = cn(
    'block w-full rounded-lg border bg-background p-4 text-left shadow-xs',
    selected && 'border-primary/50 bg-primary/5 ring-1 ring-primary/30',
    onSelect && !selected && `
      cursor-pointer transition-colors
      hover:border-primary/30
    `,
  );

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="
          text-[11px] font-semibold tracking-[0.08em] text-muted-foreground
          uppercase
        "
        >
          {title}
        </div>
        {delta && (
          <span className={cn(
            `
              inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5
              text-[11px] font-medium tabular-nums
            `,
            deltaPositive == null
              ? 'bg-muted text-muted-foreground'
              : deltaPositive
                ? `
                  bg-emerald-50 text-emerald-700
                  dark:bg-emerald-950/60 dark:text-emerald-400
                `
                : `
                  bg-red-50 text-red-700
                  dark:bg-red-950/60 dark:text-red-400
                `,
          )}
          >
            {deltaPositive != null && (deltaPositive ? '▲' : '▼')}
            {delta}
          </span>
        )}
      </div>
      <div className="
        mt-2 font-display text-3xl font-medium tracking-tight tabular-nums
      "
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      )}
    </>
  );

  if (onSelect) {
    return (
      <button type="button" onClick={onSelect} className={cardClass}>
        {inner}
      </button>
    );
  }

  return <div className={cardClass}>{inner}</div>;
}

// The metrics that have an honest per-day series to drive the chart. Flujo de
// caja neto is a period aggregate with no daily line, so it stays a plain stat.
type ChartMetric = 'ingresos' | 'ganancia' | 'ventas';

const METRIC_CONFIG: Record<ChartMetric, {
  dataKey: 'total' | 'profit' | 'count';
  color: string;
  label: string;
  money: boolean;
}> = {
  ingresos: { dataKey: 'total', color: '#0F766E', label: 'Ingresos por día', money: true },
  ganancia: { dataKey: 'profit', color: '#10B981', label: 'Ganancia por día', money: true },
  ventas: { dataKey: 'count', color: '#6366F1', label: 'Ventas por día', money: false },
};

export function DashboardClient({
  initial,
  fiado,
  lowStock,
  hasWhatsAppAgent,
}: {
  initial: DashboardMetrics;
  fiado: FiadosOverview;
  lowStock: LowStockRow[];
  hasWhatsAppAgent: boolean;
}) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [start, setStart] = useState(initial.range.start);
  const [end, setEnd] = useState(initial.range.end);
  const [compare, setCompare] = useState<boolean>(initial.compareRange !== null);
  const [activePreset, setActivePreset] = useState<RangePreset | null>(null);
  // Which metric the chart shows; selecting a KPI card drives it.
  const [metric, setMetric] = useState<ChartMetric>('ingresos');

  const [pending, startTransition] = useTransition();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      startTransition(async () => {
        const prev = compare ? computePreviousRange(start, end) : null;
        const next = await getMetrics(start, end, prev?.start, prev?.end);
        setData(next);
      });
    }, 300);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [start, end, compare]);

  const presetOptions = buildPresetOptions();

  function applyRange(next: {
    start: string;
    end: string;
    compare: boolean;
    preset: string | null;
  }) {
    setStart(next.start);
    setEnd(next.end);
    setCompare(next.compare);
    setActivePreset((next.preset as RangePreset | null) ?? null);
  }

  const prev = data.previousPeriod;

  const salesByDayLabeled = useMemo(
    () =>
      data.salesByDay.map(r => ({
        ...r,
        label: formatDayLabel(r.day),
      })),
    [data.salesByDay],
  );

  // The chart reflects the selected metric: its daily series, color and the
  // period total shown above it.
  const chart = METRIC_CONFIG[metric];
  const chartTotal
    = metric === 'ingresos'
      ? data.netRevenue
      : metric === 'ganancia'
        ? data.period.profit
        : data.period.count;
  const chartValue = chart.money ? formatMoney(chartTotal) : String(chartTotal);

  return (
    <div className="space-y-6">
      {/* Page header: identity on the left, period control on the right.
          Single source of truth — the page no longer renders its own title. */}
      <header className="
        flex flex-col gap-4
        sm:flex-row sm:items-start sm:justify-between
      "
      >
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-medium tracking-tight">
            Resumen
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ventas, ganancias, inventario y métricas operativas.
          </p>
        </div>
        <div className="
          flex flex-col items-start gap-1
          sm:items-end
        "
        >
          <DateRangePicker
            start={start}
            end={end}
            compare={compare}
            activePreset={activePreset}
            presets={presetOptions}
            maxDate={todayBogota()}
            onApply={applyRange}
          />
          <p className="min-h-4 truncate text-xs text-muted-foreground">
            {pending
              ? 'Actualizando…'
              : data.compareRange
                ? `vs ${formatRangeLabel(data.compareRange.start, data.compareRange.end)}`
                : null}
          </p>
        </div>
      </header>

      {/* WhatsApp agent CTA — only while no assistant is configured yet. */}
      {!hasWhatsAppAgent && (
        <Link
          href="/dashboard/ai-agent"
          className="
            flex items-center gap-3 rounded-lg border border-emerald-600/30
            bg-emerald-50 p-4 transition-shadow
            hover:shadow-sm
            dark:border-emerald-500/30 dark:bg-emerald-950/30
          "
        >
          <span className="
            inline-flex size-10 shrink-0 items-center justify-center rounded-xl
            bg-emerald-600 text-white
          "
          >
            <MessageCircle className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              Activá tu asistente de WhatsApp
            </div>
            <div className="text-xs text-muted-foreground">
              Tu agente IA responde, cobra fiados y avisa de stock por WhatsApp.
              Configuralo en minutos.
            </div>
          </div>
          <span className="
            inline-flex h-9 shrink-0 items-center rounded-md bg-emerald-600 px-3
            text-sm font-semibold whitespace-nowrap text-white
          "
          >
            Configurar →
          </span>
        </Link>
      )}

      {/* Hero KPIs — the handful you check every morning */}
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-3
        xl:grid-cols-4
      "
      >
        <KpiCard
          title="Ingresos netos"
          value={formatMoney(data.netRevenue)}
          selected={metric === 'ingresos'}
          onSelect={() => setMetric('ingresos')}
          delta={
            data.prevNetRevenue !== null
              ? formatDelta(data.netRevenue, data.prevNetRevenue)
              : undefined
          }
          deltaPositive={
            data.prevNetRevenue !== null
              ? deltaUp(data.netRevenue, data.prevNetRevenue)
              : undefined
          }
          hint="ya restando devoluciones"
        />
        <KpiCard
          title="Ganancia bruta"
          value={formatMoney(data.period.profit)}
          selected={metric === 'ganancia'}
          onSelect={() => setMetric('ganancia')}
          delta={prev ? formatDelta(data.period.profit, prev.profit) : undefined}
          deltaPositive={prev ? deltaUp(data.period.profit, prev.profit) : undefined}
          hint={`margen ${data.period.margin.toFixed(1)}%`}
        />
        <KpiCard
          title="Flujo de caja neto"
          value={formatMoney(data.cashFlow.net)}
          deltaPositive={data.cashFlow.net >= 0}
          delta={data.cashFlow.net >= 0 ? 'positivo' : 'negativo'}
          hint={`gastos ${formatMoney(data.cashFlow.expenses)}`}
        />
        <KpiCard
          title="Ventas"
          value={String(data.period.count)}
          selected={metric === 'ventas'}
          onSelect={() => setMetric('ventas')}
          delta={prev ? formatDelta(data.period.count, prev.count) : undefined}
          deltaPositive={prev ? deltaUp(data.period.count, prev.count) : undefined}
          hint={`ticket ${formatMoney(data.period.avgTicket)}`}
        />
      </div>

      {/* Main grid — revenue chart beside the best sellers */}
      <div className="
        grid gap-6
        lg:grid-cols-3
      "
      >
        <div className="
          rounded-lg border bg-background p-4 shadow-xs
          lg:col-span-2
        "
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="
                text-[11px] font-semibold tracking-[0.08em]
                text-muted-foreground uppercase
              "
              >
                {chart.label}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-2xl font-medium tabular-nums">
                  {chartValue}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {data.period.count}
                  {' '}
                  {data.period.count === 1 ? 'venta' : 'ventas'}
                </span>
              </div>
            </div>
            <Link
              href="/dashboard/reports"
              className="
                shrink-0 text-xs text-muted-foreground
                hover:text-primary hover:underline
              "
            >
              Ver reportes →
            </Link>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesByDayLabeled}>
                <defs>
                  <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chart.color} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={chart.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" fontSize={12} />
                <YAxis
                  fontSize={12}
                  tickFormatter={v =>
                    chart.money
                      ? compactFmt.format(Number(v))
                      : String(Math.round(Number(v)))}
                />
                <Tooltip
                  formatter={value => [
                    chart.money ? formatMoney(Number(value)) : String(value),
                    chart.label,
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey={chart.dataKey}
                  name={chart.label}
                  stroke={chart.color}
                  strokeWidth={2}
                  fill="url(#metricFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Best sellers over the selected range */}
        <div className="rounded-lg border bg-background p-4 shadow-xs">
          <div className="
            mb-1 text-[11px] font-semibold tracking-[0.08em]
            text-muted-foreground uppercase
          "
          >
            Más vendidos
          </div>
          {data.topProducts.length === 0
            ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Sin ventas en el período.
                </p>
              )
            : (
                <ul className="divide-y">
                  {data.topProducts.map(p => (
                    <li
                      key={p.name}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {p.name}
                        </div>
                        <div className="
                          text-xs text-muted-foreground tabular-nums
                        "
                        >
                          {p.qty}
                          {' '}
                          uds
                        </div>
                      </div>
                      <div className="
                        shrink-0 text-sm font-semibold tabular-nums
                      "
                      >
                        {formatMoney(p.revenue)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
        </div>
      </div>

      {/* Bottom row — outstanding fiado and the reorder list */}
      <div className="
        grid gap-6
        lg:grid-cols-2
      "
      >
        <div className="rounded-lg border bg-background p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="
              text-[11px] font-semibold tracking-[0.08em] text-muted-foreground
              uppercase
            "
            >
              Fiado pendiente
            </div>
            <Link
              href="/dashboard/fiados"
              className="
                text-xs text-muted-foreground
                hover:text-primary hover:underline
              "
            >
              Muro de fiados →
            </Link>
          </div>
          <div className="mt-1 font-display text-2xl font-medium tabular-nums">
            {formatMoney(fiado.clients.reduce((sum, c) => sum + c.balance, 0))}
          </div>
          <div className="text-xs text-muted-foreground">
            {fiado.clients.length}
            {' '}
            {fiado.clients.length === 1 ? 'persona con fiado' : 'personas con fiado'}
          </div>
          {fiado.clients.length > 0 && (
            <ul className="mt-3 divide-y">
              {fiado.clients.slice(0, 4).map(c => (
                <li
                  key={c.clientKey}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0 truncate text-sm font-medium">
                    {c.name}
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(c.balance)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border bg-background p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="
              text-[11px] font-semibold tracking-[0.08em] text-muted-foreground
              uppercase
            "
            >
              Stock crítico
            </div>
            <Link
              href="/dashboard/inventory"
              className="
                text-xs text-muted-foreground
                hover:text-primary hover:underline
              "
            >
              Inventario →
            </Link>
          </div>
          {lowStock.length === 0
            ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Todo con stock suficiente.
                </p>
              )
            : (
                <ul className="mt-2 divide-y">
                  {lowStock.map(p => (
                    <li
                      key={p.name}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-8 w-1 shrink-0 rounded-sm bg-red-500" />
                        <div className="truncate text-sm font-medium">
                          {p.name}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="
                          text-sm font-semibold text-red-600 tabular-nums
                        "
                        >
                          {p.stock}
                          {' '}
                          uds
                        </div>
                        <div className="
                          text-xs text-muted-foreground tabular-nums
                        "
                        >
                          mín
                          {' '}
                          {p.minStock}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
        </div>
      </div>
    </div>
  );
}
