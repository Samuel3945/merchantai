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
import { Button } from '@/components/ui/button';
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

const PIE_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
];

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-xs font-medium text-muted-foreground';

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
      <div className="mt-2 text-2xl font-semibold">{value}</div>
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

  function applyPreset(preset: Preset) {
    const range = presetRange(preset);
    setStart(range.start);
    setEnd(range.end);
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
      {/* Filters */}
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-6
      "
      >
        <div className="lg:col-span-1">
          <label className={labelCls}>From</label>
          <input
            type="date"
            value={start}
            max={end}
            onChange={e => setStart(e.target.value)}
            className={inputCls}
          />
        </div>
        <div className="lg:col-span-1">
          <label className={labelCls}>To</label>
          <input
            type="date"
            value={end}
            min={start}
            max={todayBogota()}
            onChange={e => setEnd(e.target.value)}
            className={inputCls}
          />
        </div>
        <div className="
          flex items-end gap-2
          lg:col-span-3
        "
        >
          <Button variant="secondary" size="sm" onClick={() => applyPreset('7d')}>
            7d
          </Button>
          <Button variant="secondary" size="sm" onClick={() => applyPreset('30d')}>
            30d
          </Button>
          <Button variant="secondary" size="sm" onClick={() => applyPreset('90d')}>
            90d
          </Button>
          <Button variant="secondary" size="sm" onClick={() => applyPreset('mtd')}>
            MTD
          </Button>
        </div>
        <div className="
          flex items-end justify-end gap-3 text-sm
          lg:col-span-1
        "
        >
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={compare}
              onChange={e => setCompare(e.target.checked)}
              className="size-4"
            />
            Compare prev.
          </label>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {pending ? 'Loading…' : `Range: ${data.range.start} → ${data.range.end}`}
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
          title="Revenue"
          value={formatMoney(data.period.total)}
          delta={prev ? formatDelta(data.period.total, prev.total) : undefined}
          deltaClass={prev ? deltaTone(data.period.total, prev.total) : undefined}
          hint={prev ? `prev ${formatMoney(prev.total)}` : undefined}
        />
        <KpiCard
          title="Sales"
          value={String(data.period.count)}
          delta={prev ? formatDelta(data.period.count, prev.count) : undefined}
          deltaClass={prev ? deltaTone(data.period.count, prev.count) : undefined}
          hint={prev ? `prev ${prev.count}` : undefined}
        />
        <KpiCard
          title="Avg ticket"
          value={formatMoney(data.period.avgTicket)}
          delta={
            prev ? formatDelta(data.period.avgTicket, prev.avgTicket) : undefined
          }
          deltaClass={
            prev ? deltaTone(data.period.avgTicket, prev.avgTicket) : undefined
          }
        />
        <KpiCard
          title="Profit"
          value={formatMoney(data.period.profit)}
          delta={prev ? formatDelta(data.period.profit, prev.profit) : undefined}
          deltaClass={prev ? deltaTone(data.period.profit, prev.profit) : undefined}
        />
        <KpiCard
          title="Margin"
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
          title="Inventory value"
          value={formatMoney(data.inventory.value)}
        />
        <KpiCard
          title="Products"
          value={String(data.inventory.total)}
        />
        <KpiCard
          title="Low stock (1-5)"
          value={String(data.inventory.lowStock)}
          deltaClass={data.inventory.lowStock > 0 ? 'text-amber-600' : undefined}
        />
        <KpiCard
          title="Out of stock"
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
        <ChartCard title="Sales by day" className="lg:col-span-2">
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
                    name === 'Revenue'
                      ? [formatMoney(Number(value)), 'Revenue']
                      : [String(value), 'Sales']}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="total"
                  name="Revenue"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  name="Sales"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Sales by hour (Bogotá)">
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
                  formatter={value => [formatMoney(Number(value)), 'Revenue']}
                />
                <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Payment breakdown">
          {data.paymentBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  No data
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

        <ChartCard title="Category breakdown">
          {data.categoryBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  No data
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
                          'Revenue',
                        ]}
                      />
                      <Bar dataKey="revenue" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
        </ChartCard>

        <ChartCard title="Cashier breakdown">
          {data.cashierBreakdown.length === 0
            ? (
                <div className="
                  flex h-64 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  No cashier-attributed sales
                </div>
              )
            : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase">
                      <tr>
                        <th className="px-3 py-2">Cashier ID</th>
                        <th className="px-3 py-2 text-right">Sales</th>
                        <th className="px-3 py-2 text-right">Revenue</th>
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
          Top 10 products by revenue
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Revenue</th>
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
                        No sales in the selected range
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
