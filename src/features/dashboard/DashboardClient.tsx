'use client';

import type { DashboardMetrics } from '@/actions/dashboard';
import type { RangePreset } from '@/utils/DateRange';
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

function deltaTone(current: number, previous: number, invert = false) {
  if (previous === 0 && current === 0) {
    return 'text-muted-foreground';
  }
  const better = invert ? current < previous : current > previous;
  if (current === previous) {
    return 'text-muted-foreground';
  }
  return better ? 'text-emerald-600' : 'text-red-600';
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
  deltaClass,
  accent,
}: {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaClass?: string;
  accent?: boolean;
}) {
  return (
    <div className={cn(
      'rounded-lg border bg-background p-4 shadow-xs',
      accent && 'border-primary/40 bg-primary/5',
    )}
    >
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="
        mt-2 font-display text-3xl font-medium tracking-tight tabular-nums
      "
      >
        {value}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {delta && <span className={cn('font-medium', deltaClass)}>{delta}</span>}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

export function DashboardClient({ initial }: { initial: DashboardMetrics }) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [start, setStart] = useState(initial.range.start);
  const [end, setEnd] = useState(initial.range.end);
  const [compare, setCompare] = useState<boolean>(initial.compareRange !== null);
  const [activePreset, setActivePreset] = useState<RangePreset | null>(null);

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

      {/* Hero KPIs — the handful you check every morning */}
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        <KpiCard
          title="Ingresos netos"
          value={formatMoney(data.netRevenue)}
          accent
          delta={
            data.prevNetRevenue !== null
              ? formatDelta(data.netRevenue, data.prevNetRevenue)
              : undefined
          }
          deltaClass={
            data.prevNetRevenue !== null
              ? deltaTone(data.netRevenue, data.prevNetRevenue)
              : undefined
          }
          hint="ya restando devoluciones"
        />
        <KpiCard
          title="Ganancia bruta"
          value={formatMoney(data.period.profit)}
          delta={prev ? formatDelta(data.period.profit, prev.profit) : undefined}
          deltaClass={prev ? deltaTone(data.period.profit, prev.profit) : undefined}
          hint={`margen ${data.period.margin.toFixed(1)}%`}
        />
        <KpiCard
          title="Flujo de caja neto"
          value={formatMoney(data.cashFlow.net)}
          deltaClass={data.cashFlow.net >= 0 ? 'text-emerald-600' : 'text-red-600'}
          delta={data.cashFlow.net >= 0 ? 'positivo' : 'negativo'}
          hint={`gastos ${formatMoney(data.cashFlow.expenses)}`}
        />
        <KpiCard
          title="Ventas"
          value={String(data.period.count)}
          delta={prev ? formatDelta(data.period.count, prev.count) : undefined}
          deltaClass={prev ? deltaTone(data.period.count, prev.count) : undefined}
          hint={`ticket ${formatMoney(data.period.avgTicket)}`}
        />
      </div>

      {/* Hero chart — revenue trend over the selected range */}
      <div className="rounded-lg border bg-background p-4 shadow-xs">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">Ingresos por día</div>
          <Link
            href="/dashboard/reports"
            className="
              text-xs text-muted-foreground
              hover:text-primary hover:underline
            "
          >
            Ver todos los reportes →
          </Link>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={salesByDayLabeled}>
              <defs>
                <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0F766E" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#0F766E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="label" fontSize={12} />
              <YAxis
                fontSize={12}
                tickFormatter={v => compactFmt.format(Number(v))}
              />
              <Tooltip
                formatter={value => [formatMoney(Number(value)), 'Ingresos']}
              />
              <Area
                type="monotone"
                dataKey="total"
                name="Ingresos"
                stroke="#0F766E"
                strokeWidth={2}
                fill="url(#revFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
