'use client';

import type { DashboardMetrics } from '@/actions/dashboard';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getMetrics } from '@/actions/dashboard';
import { cn } from '@/utils/Helpers';
import { DateRangePicker } from './DateRangePicker';

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

// Paleta de marca Tienda Control (teal/verde/terracota/ámbar/azul) — sin
// purple/pink/cyan genéricos del boilerplate.
const PIE_COLORS = [
  '#0F766E', // teal (primary)
  '#15803D', // verde (success)
  '#C2410C', // terracota (accent)
  '#B45309', // ámbar (warn)
  '#1D4ED8', // azul (info)
  '#0891B2', // teal-cian
  '#65A30D', // verde lima
  '#D97706', // naranja cálido
];

function formatMoney(value: number) {
  return moneyFmt.format(value);
}

function formatDelta(current: number, previous: number) {
  if (previous === 0) {
    return current > 0 ? '+∞' : '0%';
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

function todayBogota(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return iso;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(start: string, end: string): number {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  if (!ys || !ms || !ds || !ye || !me || !de) {
    return 0;
  }
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  return Math.round((b - a) / 86_400_000);
}

function computePreviousRange(start: string, end: string) {
  const span = diffDays(start, end);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -span);
  return { start: prevStart, end: prevEnd };
}

type Preset = '7d' | '30d' | '90d' | 'mtd';

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: '90d', label: '90 días' },
  { key: 'mtd', label: 'Mes actual' },
];

function presetRange(preset: Preset): { start: string; end: string } {
  const end = todayBogota();
  if (preset === 'mtd') {
    return { start: `${end.slice(0, 7)}-01`, end };
  }
  const days = preset === '7d' ? 6 : preset === '30d' ? 29 : 89;
  return { start: addDays(end, -days), end };
}

function KpiCard({
  title,
  value,
  hint,
  delta,
  deltaClass,
}: {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
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

function ChartCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border bg-background p-4 shadow-xs', className)}>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

export function DashboardClient({ initial }: { initial: DashboardMetrics }) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [start, setStart] = useState(initial.range.start);
  const [end, setEnd] = useState(initial.range.end);
  const [compare, setCompare] = useState<boolean>(initial.compareRange !== null);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);

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
        const next = await getMetrics(
          start,
          end,
          prev?.start,
          prev?.end,
        );
        setData(next);
      });
    }, 300);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [start, end, compare]);

  // Precompute each preset's concrete range so the picker stays free of date
  // math (it only renders and stages the selection).
  const presetOptions = PRESETS.map(p => ({
    key: p.key,
    label: p.label,
    range: presetRange(p.key),
  }));

  function applyRange(next: {
    start: string;
    end: string;
    compare: boolean;
    preset: string | null;
  }) {
    setStart(next.start);
    setEnd(next.end);
    setCompare(next.compare);
    setActivePreset((next.preset as Preset | null) ?? null);
  }

  const prev = data.previousPeriod;

  const salesByHourFull = useMemo(() => {
    const map = new Map(data.salesByHour.map(r => [r.hour, r]));
    return Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      hourLabel: `${String(h).padStart(2, '0')}:00`,
      count: map.get(h)?.count ?? 0,
      total: map.get(h)?.total ?? 0,
    }));
  }, [data.salesByHour]);

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
      {/* Filtros — barra coherente con Tienda Control */}
      <div className="
        flex flex-col gap-4 rounded-lg border bg-card p-4 shadow-xs
        lg:flex-row lg:flex-wrap lg:items-end lg:justify-between
      "
      >
        {/* Rango de fechas — picker estilo Shopify (presets + calendario) */}
        <DateRangePicker
          start={start}
          end={end}
          compare={compare}
          activePreset={activePreset}
          presets={presetOptions}
          maxDate={todayBogota()}
          onApply={applyRange}
        />
      </div>

      <div className="text-xs text-muted-foreground">
        {pending
          ? 'Cargando…'
          : `Rango: ${data.range.start} → ${data.range.end}`}
        {data.compareRange
          && ` · vs ${data.compareRange.start} → ${data.compareRange.end}`}
      </div>

      {/* KPI cards */}
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-5
      "
      >
        <KpiCard
          title="Ingresos"
          value={formatMoney(data.period.total)}
          delta={prev ? formatDelta(data.period.total, prev.total) : undefined}
          deltaClass={prev ? deltaTone(data.period.total, prev.total) : undefined}
          hint={prev ? `ant. ${formatMoney(prev.total)}` : undefined}
        />
        <KpiCard
          title="Ventas"
          value={String(data.period.count)}
          delta={prev ? formatDelta(data.period.count, prev.count) : undefined}
          deltaClass={prev ? deltaTone(data.period.count, prev.count) : undefined}
          hint={prev ? `ant. ${prev.count}` : undefined}
        />
        <KpiCard
          title="Ticket promedio"
          value={formatMoney(data.period.avgTicket)}
          delta={
            prev ? formatDelta(data.period.avgTicket, prev.avgTicket) : undefined
          }
          deltaClass={
            prev ? deltaTone(data.period.avgTicket, prev.avgTicket) : undefined
          }
        />
        <KpiCard
          title="Ganancia"
          value={formatMoney(data.period.profit)}
          delta={prev ? formatDelta(data.period.profit, prev.profit) : undefined}
          deltaClass={prev ? deltaTone(data.period.profit, prev.profit) : undefined}
        />
        <KpiCard
          title="Margen"
          value={`${data.period.margin.toFixed(1)}%`}
          delta={prev ? `${(data.period.margin - prev.margin).toFixed(1)} pts` : undefined}
          deltaClass={prev ? deltaTone(data.period.margin, prev.margin) : undefined}
        />
      </div>

      {/* Inventory KPIs */}
      <div className="
        grid grid-cols-2 gap-3
        sm:grid-cols-4
      "
      >
        <KpiCard
          title="Valor del inventario"
          value={formatMoney(data.inventory.value)}
        />
        <KpiCard
          title="Productos"
          value={String(data.inventory.total)}
        />
        <KpiCard
          title="Stock bajo (1-5)"
          value={String(data.inventory.lowStock)}
          deltaClass={data.inventory.lowStock > 0 ? 'text-amber-600' : undefined}
        />
        <KpiCard
          title="Sin stock"
          value={String(data.inventory.outOfStock)}
          deltaClass={data.inventory.outOfStock > 0 ? 'text-red-600' : undefined}
        />
      </div>

      {/* Charts */}
      <div className="
        grid grid-cols-1 gap-4
        lg:grid-cols-2
      "
      >
        <ChartCard title="Ventas por día" className="lg:col-span-2">
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={salesByDayLabeled}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" fontSize={12} />
                <YAxis
                  fontSize={12}
                  tickFormatter={v => compactFmt.format(Number(v))}
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'Ingresos'
                      ? [formatMoney(Number(value)), 'Ingresos']
                      : [String(value), 'Ventas']}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="total"
                  name="Ingresos"
                  stroke="#0F766E"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  name="Ventas"
                  stroke="#15803D"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Ventas por hora (Bogotá)">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={salesByHourFull}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="hourLabel" fontSize={11} interval={1} />
                <YAxis
                  fontSize={12}
                  tickFormatter={v => compactFmt.format(Number(v))}
                />
                <Tooltip
                  formatter={value => [formatMoney(Number(value)), 'Ingresos']}
                />
                <Bar dataKey="total" fill="#0F766E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Desglose por pago">
          {data.paymentBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  Sin datos
                </div>
              )
            : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.paymentBreakdown}
                        dataKey="total"
                        nameKey="paymentType"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={(props) => {
                          const p = props as unknown as {
                            paymentType?: string;
                            total?: number;
                          };
                          return `${p.paymentType ?? ''}: ${compactFmt.format(Number(p.total ?? 0))}`;
                        }}
                      >
                        {data.paymentBreakdown.map((_, i) => (
                          <Cell
                            key={`cell-${i}`}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={value => formatMoney(Number(value))}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
        </ChartCard>

        <ChartCard title="Desglose por categoría">
          {data.categoryBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  Sin datos
                </div>
              )
            : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.categoryBreakdown.slice(0, 8)}
                      layout="vertical"
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis
                        type="number"
                        fontSize={11}
                        tickFormatter={v => compactFmt.format(Number(v))}
                      />
                      <YAxis
                        type="category"
                        dataKey="category"
                        width={110}
                        fontSize={11}
                      />
                      <Tooltip
                        formatter={value => [
                          formatMoney(Number(value)),
                          'Ingresos',
                        ]}
                      />
                      <Bar dataKey="revenue" fill="#C2410C" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
        </ChartCard>

        <ChartCard title="Desglose por cajero">
          {data.cashierBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  Sin ventas atribuidas a cajeros
                </div>
              )
            : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase">
                      <tr>
                        <th className="px-3 py-2">ID de cajero</th>
                        <th className="px-3 py-2 text-right">Ventas</th>
                        <th className="px-3 py-2 text-right">Ingresos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cashierBreakdown.map(c => (
                        <tr key={c.cashierId} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs">
                            {c.cashierId}
                          </td>
                          <td className="px-3 py-2 text-right">{c.count}</td>
                          <td className="px-3 py-2 text-right font-medium">
                            {formatMoney(c.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </ChartCard>
      </div>

      {/* Top products table */}
      <div className="rounded-lg border bg-background shadow-xs">
        <div className="border-b px-4 py-3 text-sm font-semibold">
          Top 10 productos por ingresos
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Producto</th>
                <th className="px-3 py-2 text-right">Cant.</th>
                <th className="px-3 py-2 text-right">Ingresos</th>
              </tr>
            </thead>
            <tbody>
              {data.topProducts.length === 0
                ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-3 py-8 text-center text-muted-foreground"
                      >
                        Sin ventas en el rango seleccionado
                      </td>
                    </tr>
                  )
                : (
                    data.topProducts.map((p, i) => (
                      <tr key={p.id} className="border-t">
                        <td className="px-3 py-2 text-muted-foreground">
                          {i + 1}
                        </td>
                        <td className="px-3 py-2">{p.name}</td>
                        <td className="px-3 py-2 text-right">{p.qty}</td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatMoney(p.revenue)}
                        </td>
                      </tr>
                    ))
                  )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
