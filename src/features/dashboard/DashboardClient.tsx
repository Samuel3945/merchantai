'use client';

import type {
  DashboardMetrics,
  LowStockRow,
  StockCategoryRow,
} from '@/actions/dashboard';
import type { CreditosOverview } from '@/libs/creditos';
import type { RangePreset } from '@/utils/DateRange';
import { useOrganization } from '@clerk/nextjs';
import { Bot, MessageCircle } from 'lucide-react';
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

type BotMessage = { text: string; time: string };

// Builds the WhatsApp preview from THIS business's real data — its sales, its
// top debtor, its low-stock product, its best seller — so the teaser is coherent
// with the store instead of a generic mock.
function buildAssistantMessages(
  data: DashboardMetrics,
  credito: CreditosOverview,
  lowStock: LowStockRow[],
): BotMessage[] {
  const msgs: BotMessage[] = [{ text: 'Buenos días 👋', time: '7:02' }];

  if (data.period.total > 0) {
    msgs.push({
      text: `Llevás ${formatMoney(data.period.total)} en ventas (${
        data.period.count
      } ${data.period.count === 1 ? 'venta' : 'ventas'}).`,
      time: '7:03',
    });
  }

  const debtor = credito.clients[0];
  if (debtor && debtor.balance > 0) {
    msgs.push({
      text: `${debtor.name} te debe ${formatMoney(
        debtor.balance,
      )}. ¿Le mando un recordatorio?`,
      time: '9:15',
    });
  }

  const low = lowStock[0];
  if (low) {
    msgs.push({
      text: `Quedan ${low.stock} ${low.name}. ¿Hago el pedido al proveedor?`,
      time: '11:48',
    });
  }

  const top = data.topProducts[0];
  if (top) {
    msgs.push({
      text: `${top.name} es lo más vendido (${top.qty} uds). ¿Pido más?`,
      time: '13:20',
    });
  }

  if (msgs.length === 1) {
    msgs.push({
      text: 'Te aviso por acá cuando algo necesite tu atención.',
      time: '7:03',
    });
  }

  return msgs;
}

// Looping WhatsApp-style chat showing what the assistant would message the
// owner, built from this store's real data. Pure decoration; cleans up on unmount.
function WhatsAppPreview({
  messages,
  orgName,
}: {
  messages: BotMessage[];
  orgName?: string;
}) {
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Held in an object so the cleanup can cancel the async loop (a plain `let`
    // trips no-unmodified-loop-condition since it's only flipped in cleanup).
    const state = { running: true };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, ms));
      });
    (async () => {
      while (state.running) {
        setShown(0);
        setTyping(false);
        await wait(800);
        for (let i = 0; i < messages.length && state.running; i++) {
          setTyping(true);
          await wait(i === 0 ? 700 : 1300);
          if (!state.running) {
            break;
          }
          setTyping(false);
          setShown(i + 1);
          await wait(1500);
        }
        await wait(2800);
      }
    })();
    return () => {
      state.running = false;
      timers.forEach(clearTimeout);
    };
  }, [messages]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [shown, typing]);

  return (
    <div className="
      flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm
    "
    >
      <style>
        {`@keyframes waPop{from{opacity:0;transform:translateY(7px) scale(.97)}to{opacity:1;transform:none}}@keyframes waDot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}`}
      </style>
      <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
        <span className="
          inline-flex size-7 shrink-0 items-center justify-center rounded-full
          bg-[#25D366] text-white
        "
        >
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {orgName ? `Asistente · ${orgName}` : 'Asistente'}
          </div>
          <div className="
            flex items-center gap-1 text-[10px] text-muted-foreground
          "
          >
            <span className="size-1.5 rounded-full bg-[#25D366]" />
            en línea
          </div>
        </div>
      </div>
      <div
        ref={bodyRef}
        className="
          flex scrollbar-subtle h-[180px] flex-col overflow-y-auto px-2.5 py-3
        "
      >
        <div className="mt-auto flex flex-col gap-1.5">
          {messages.slice(0, shown).map(m => (
            <div
              key={m.text}
              className="
                max-w-[88%] self-start rounded-[2px_10px_10px_10px] border
                bg-card px-2.5 py-1.5 text-xs/snug text-card-foreground
                shadow-sm
              "
              style={{ animation: 'waPop .26s ease both' }}
            >
              {m.text}
              <span className="
                float-right mt-1 ml-2 text-[9.5px] text-muted-foreground
                tabular-nums
              "
              >
                {m.time}
              </span>
            </div>
          ))}
          {typing && (
            <div
              className="
                flex gap-1 self-start rounded-[2px_10px_10px_10px] border
                bg-card px-3 py-2.5 shadow-sm
              "
              style={{ animation: 'waPop .2s ease both' }}
            >
              {[0, 1, 2].map(d => (
                <span
                  key={d}
                  className="size-1.5 rounded-full bg-muted-foreground/50"
                  style={{
                    animation: 'waDot 1.2s infinite',
                    animationDelay: `${d * 0.18}s`,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
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
  color,
  selected,
  onSelect,
}: {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaPositive?: boolean | null;
  // The metric's accent color. When `selected`, it paints the border and the big
  // number so the card visibly matches the chart it drives.
  color?: string;
  // When `selected`, the card is the one driving the chart below. `onSelect`
  // makes it interactive; without it the card is a plain stat (e.g. Flujo, which
  // has no daily series to chart).
  selected?: boolean;
  onSelect?: () => void;
}) {
  const cardClass = cn(
    'block w-full rounded-lg border bg-background p-4 text-left shadow-xs',
    selected && 'shadow-sm',
    onSelect && !selected && `
      cursor-pointer transition-colors
      hover:border-primary/30
    `,
  );
  // Selected → metric-colored 1.5px border + a faint tint of the same color.
  const cardStyle = selected && color
    ? { borderColor: color, borderWidth: 1.5, backgroundColor: `${color}14` }
    : undefined;

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
      <div
        className="
          mt-2 font-display text-3xl font-medium tracking-tight tabular-nums
        "
        style={selected && color ? { color } : undefined}
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
      <button
        type="button"
        onClick={onSelect}
        className={cardClass}
        style={cardStyle}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={cardClass} style={cardStyle}>
      {inner}
    </div>
  );
}

// The metrics that have an honest per-day series to drive the chart. Flujo de
// caja neto is a period aggregate with no daily line, so it stays a plain stat.
// All four KPIs drive the chart, each with its own series and color.
type ChartMetric = 'ventas' | 'ganancia' | 'cobrar' | 'stock';

const METRIC_CONFIG: Record<ChartMetric, {
  color: string;
  label: string;
  money: boolean;
}> = {
  ventas: { color: '#0F766E', label: 'Ventas por día', money: true },
  ganancia: { color: '#10B981', label: 'Ganancia por día', money: true },
  cobrar: { color: '#B45309', label: 'Credito por día', money: true },
  stock: { color: '#DC2626', label: 'Stock crítico por categoría', money: false },
};

export function DashboardClient({
  initial,
  credito,
  lowStock,
  stockByCategory,
  hasWhatsAppAgent,
  aiEnabled,
}: {
  initial: DashboardMetrics;
  credito: CreditosOverview;
  lowStock: LowStockRow[];
  stockByCategory: StockCategoryRow[];
  hasWhatsAppAgent: boolean;
  aiEnabled: boolean;
}) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [start, setStart] = useState(initial.range.start);
  const [end, setEnd] = useState(initial.range.end);
  const [compare, setCompare] = useState<boolean>(initial.compareRange !== null);
  const [activePreset, setActivePreset] = useState<RangePreset | null>(null);
  // Which metric the chart shows; selecting a KPI card drives it.
  const [metric, setMetric] = useState<ChartMetric>('ventas');
  const { organization } = useOrganization();

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
  const creditoTotal = credito.clients.reduce((sum, c) => sum + c.balance, 0);
  const botMessages = useMemo(
    () => buildAssistantMessages(data, credito, lowStock),
    [data, credito, lowStock],
  );

  // The chart reflects the selected KPI: each metric maps to its own {x,y}
  // series — sales/profit/credito by day, or low stock by category.
  const chart = METRIC_CONFIG[metric];
  const chartSeries = useMemo(() => {
    switch (metric) {
      case 'ganancia':
        return data.salesByDay.map(r => ({ x: formatDayLabel(r.day), y: r.profit }));
      case 'cobrar':
        return data.creditoByDay.map(r => ({ x: formatDayLabel(r.day), y: r.amount }));
      case 'stock':
        return stockByCategory.map(r => ({ x: r.category, y: r.count }));
      default:
        return data.salesByDay.map(r => ({ x: formatDayLabel(r.day), y: r.total }));
    }
  }, [metric, data.salesByDay, data.creditoByDay, stockByCategory]);
  const chartValue = chart.money
    ? formatMoney(
        metric === 'ganancia'
          ? data.period.profit
          : metric === 'cobrar'
            ? creditoTotal
            : data.period.total,
      )
    : String(lowStock.length);
  const chartSub = metric === 'cobrar'
    ? `${credito.clients.length} ${credito.clients.length === 1 ? 'cliente' : 'clientes'}`
    : metric === 'stock'
      ? `${lowStock.length} ${lowStock.length === 1 ? 'producto' : 'productos'}`
      : `${data.period.count} ${data.period.count === 1 ? 'venta' : 'ventas'}`;

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

      {/* Hero KPIs — the Claude Design set. All four drive the chart. */}
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        <KpiCard
          title="Ventas hoy"
          value={formatMoney(data.period.total)}
          selected={metric === 'ventas'}
          onSelect={() => setMetric('ventas')}
          color={METRIC_CONFIG.ventas.color}
          delta={prev ? formatDelta(data.period.total, prev.total) : undefined}
          deltaPositive={prev ? deltaUp(data.period.total, prev.total) : undefined}
          hint={`${data.period.count} ${data.period.count === 1 ? 'venta' : 'ventas'}`}
        />
        <KpiCard
          title="Ganancia hoy"
          value={formatMoney(data.period.profit)}
          selected={metric === 'ganancia'}
          onSelect={() => setMetric('ganancia')}
          color={METRIC_CONFIG.ganancia.color}
          delta={prev ? formatDelta(data.period.profit, prev.profit) : undefined}
          deltaPositive={prev ? deltaUp(data.period.profit, prev.profit) : undefined}
          hint={`margen ${data.period.margin.toFixed(1)}%`}
        />
        <KpiCard
          title="Por cobrar"
          value={formatMoney(creditoTotal)}
          selected={metric === 'cobrar'}
          onSelect={() => setMetric('cobrar')}
          color={METRIC_CONFIG.cobrar.color}
          hint={`${credito.clients.length} ${
            credito.clients.length === 1 ? 'cliente con credito' : 'clientes con credito'
          }`}
        />
        <KpiCard
          title="Stock crítico"
          value={String(lowStock.length)}
          selected={metric === 'stock'}
          onSelect={() => setMetric('stock')}
          color={METRIC_CONFIG.stock.color}
          hint="productos para reponer"
        />
      </div>

      {/* Main grid — revenue chart beside the best sellers */}
      <div className="
        grid gap-6
        lg:grid-cols-3
      "
      >
        <div className="
          flex flex-col rounded-lg border bg-background p-4 shadow-xs
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
                  {chartSub}
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
          {/* flex-1 + min-h so the chart fills the card the grid stretches to
              match the sidebar — no empty gap below it. */}
          <div className="min-h-72 w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartSeries}>
                <defs>
                  <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chart.color} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={chart.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="x" fontSize={12} />
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
                  dataKey="y"
                  name={chart.label}
                  stroke={chart.color}
                  strokeWidth={2}
                  fill="url(#metricFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right sidebar — WhatsApp CTA (only when no agent) + best sellers */}
        <div className="flex flex-col gap-6">
          {aiEnabled && !hasWhatsAppAgent && (
            <div className="
              flex flex-col gap-3 rounded-lg border bg-card p-4
              text-card-foreground shadow-xs
            "
            >
              <div className="flex items-center gap-2.5">
                <span className="
                  inline-flex size-8 shrink-0 items-center justify-center
                  rounded-[10px] bg-[#25D366] text-white
                "
                >
                  <MessageCircle className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    Tu asistente por WhatsApp
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    mirá lo que te avisaría hoy, en vivo
                  </div>
                </div>
              </div>
              <WhatsAppPreview
                messages={botMessages}
                orgName={organization?.name}
              />
              <Link
                href="/dashboard/ai-agent"
                className="
                  inline-flex h-10 items-center justify-center gap-2 rounded-md
                  bg-primary px-4 text-sm font-semibold text-primary-foreground
                  transition-colors
                  hover:bg-primary/90
                "
              >
                <MessageCircle className="size-4" />
                Conectar WhatsApp
              </Link>
            </div>
          )}
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
                        className="
                          flex items-center justify-between gap-3 py-2.5
                        "
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
      </div>

      {/* Bottom row — outstanding credito and the reorder list */}
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
              Credito pendiente
            </div>
            <Link
              href="/dashboard/creditos"
              className="
                text-xs text-muted-foreground
                hover:text-primary hover:underline
              "
            >
              Muro de creditos →
            </Link>
          </div>
          <div className="mt-1 font-display text-2xl font-medium tabular-nums">
            {formatMoney(credito.clients.reduce((sum, c) => sum + c.balance, 0))}
          </div>
          <div className="text-xs text-muted-foreground">
            {credito.clients.length}
            {' '}
            {credito.clients.length === 1 ? 'persona con credito' : 'personas con credito'}
          </div>
          {credito.clients.length > 0 && (
            <ul className="mt-3 divide-y">
              {credito.clients.slice(0, 4).map(c => (
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
