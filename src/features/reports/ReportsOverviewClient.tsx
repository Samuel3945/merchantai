'use client';

import type { ReactNode } from 'react';
import type { ReportsOverview } from '@/actions/reports';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { getReportsOverview } from '@/actions/reports';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const percentFmt = new Intl.NumberFormat('es-CO', {
  style: 'percent',
  maximumFractionDigits: 1,
});

function money(value: number): string {
  return moneyFmt.format(value);
}

function todayBogota(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDelta(current: number, previous: number): string | null {
  if (previous === 0) {
    return current > 0 ? 'nuevo' : null;
  }
  const delta = (current - previous) / previous;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${percentFmt.format(delta)} vs período anterior`;
}

function deltaTone(current: number, previous: number): string {
  if (current === previous) {
    return 'text-muted-foreground';
  }
  return current > previous ? 'text-emerald-600' : 'text-red-600';
}

type Preset = { key: string; label: string; days: number };

const PRESETS: Preset[] = [
  { key: '7d', label: 'Últimos 7 días', days: 7 },
  { key: '30d', label: 'Últimos 30 días', days: 30 },
  { key: '90d', label: 'Últimos 90 días', days: 90 },
];

/**
 * One report summary. The headline number answers "how much", the explanation
 * answers "what is this and why should I care" in plain shopkeeper language —
 * the whole point is that a non-technical owner understands it without help.
 */
function ReportCard({
  title,
  value,
  secondary,
  explanation,
  delta,
  deltaClass,
  tone,
  href,
  children,
}: {
  title: string;
  value: string;
  secondary?: string;
  explanation: string;
  delta?: string | null;
  deltaClass?: string;
  tone?: 'default' | 'warn' | 'danger';
  href: string;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="
        group flex flex-col rounded-lg border bg-background p-5 shadow-xs
        transition-colors
        hover:border-primary/50 hover:bg-accent/30
      "
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        <span className="
          text-xs text-muted-foreground opacity-0 transition-opacity
          group-hover:opacity-100
        "
        >
          Ver detalle →
        </span>
      </div>

      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cn(
            'font-display text-2xl font-medium tracking-tight tabular-nums',
            tone === 'danger' && 'text-red-600',
            tone === 'warn' && 'text-amber-600',
          )}
          >
            {value}
          </div>
          {secondary && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {secondary}
            </div>
          )}
        </div>
        {children && <div className="h-10 w-24 shrink-0">{children}</div>}
      </div>

      {delta && (
        <div className={cn('mt-1 text-xs font-medium', deltaClass)}>{delta}</div>
      )}

      <p className="mt-3 text-xs/relaxed text-muted-foreground">
        {explanation}
      </p>
    </Link>
  );
}

function Sparkline({ data }: { data: { day: string; total: number }[] }) {
  if (data.length < 2) {
    return null;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <Line
          type="monotone"
          dataKey="total"
          stroke="#0F766E"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ReportsOverviewClient({ initial }: { initial: ReportsOverview }) {
  const [data, setData] = useState<ReportsOverview>(initial);
  const [activePreset, setActivePreset] = useState('30d');
  const [pending, startTransition] = useTransition();
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const preset = PRESETS.find(p => p.key === activePreset) ?? PRESETS[1]!;
    const end = todayBogota();
    const start = addDays(end, -(preset.days - 1));
    startTransition(async () => {
      setData(await getReportsOverview(start, end));
    });
  }, [activePreset]);

  const fmtMethod = (m: string) =>
    m ? m.charAt(0).toUpperCase() + m.slice(1) : '—';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => setActivePreset(p.key)}
            className={cn(
              `
                rounded-md border px-3 py-1.5 text-xs font-medium
                transition-colors
              `,
              activePreset === p.key
                ? 'border-primary bg-primary/10 text-primary'
                : `
                  bg-background text-muted-foreground
                  hover:bg-accent/40
                `,
            )}
          >
            {p.label}
          </button>
        ))}
        {pending && (
          <span className="text-xs text-muted-foreground">Actualizando…</span>
        )}
      </div>

      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-2
        lg:grid-cols-3
      "
      >
        <ReportCard
          title="Ventas"
          value={money(data.sales.total)}
          secondary={`${data.sales.count} ventas · ticket ${money(data.sales.avgTicket)}`}
          explanation="Cuánto facturaste en total. Es tu termómetro principal: si este número sube, estás vendiendo más."
          delta={formatDelta(data.sales.total, data.sales.prevTotal)}
          deltaClass={deltaTone(data.sales.total, data.sales.prevTotal)}
          href="/dashboard/reports/ventas-periodo"
        >
          <Sparkline data={data.sales.spark} />
        </ReportCard>

        <ReportCard
          title="Ganancia"
          value={money(data.profit.profit)}
          secondary={`margen ${data.profit.margin.toFixed(1)}%`}
          explanation="Lo que te queda después de pagar lo que costó la mercadería. Vender mucho con poca ganancia es trabajar para nada."
          delta={formatDelta(data.profit.profit, data.profit.prevProfit)}
          deltaClass={deltaTone(data.profit.profit, data.profit.prevProfit)}
          href="/dashboard/reports/ventas-periodo"
        />

        <ReportCard
          title="Producto estrella"
          value={data.topProduct.name || '—'}
          secondary={
            data.topProduct.name
              ? `${money(data.topProduct.revenue)} · ${data.topProduct.qty} uds`
              : 'Sin ventas en el período'
          }
          explanation="El producto que más plata te deja. Nunca lo dejes sin stock: es el que sostiene el negocio."
          href="/dashboard/reports/top-productos"
        />

        <ReportCard
          title="Método de pago dominante"
          value={fmtMethod(data.payment.topMethod)}
          secondary={
            data.payment.methodCount > 0
              ? `${data.payment.topPct.toFixed(0)}% de las ventas · ${data.payment.methodCount} métodos`
              : 'Sin ventas en el período'
          }
          explanation="Cómo te paga la gente. Si mucho es fiado o transferencia, ojo: es plata que todavía no tenés en mano."
          href="/dashboard/reports/ventas-metodo"
        />

        <ReportCard
          title="Cajeros activos"
          value={String(data.cashier.activeCashiers)}
          secondary={
            data.cashier.topName
              ? `Top: ${data.cashier.topName} (${money(data.cashier.topTotal)})`
              : 'Sin ventas atribuidas'
          }
          explanation="Quién vende y cuánto. Sirve para premiar al que rinde y detectar al que no está aportando."
          href="/dashboard/reports/ventas-cajero"
        />

        <ReportCard
          title="Caja"
          value={money(data.cash.totalDifference)}
          secondary={`${data.cash.sessions} cierres · ${data.cash.alerts} alertas`}
          explanation="Diferencia entre lo que debía haber en caja y lo que se contó. Cerca de cero está bien; diferencias grandes son error o robo."
          tone={data.cash.alerts > 0 ? 'danger' : 'default'}
          delta={data.cash.alerts > 0 ? `${data.cash.alerts} cierre(s) requieren revisión` : null}
          deltaClass="text-red-600"
          href="/dashboard/reports/analisis-caja"
        />

        <ReportCard
          title="Valor del inventario"
          value={money(data.inventory.value)}
          secondary={`${data.inventory.products} productos`}
          explanation="Cuánta plata tenés inmovilizada en mercadería. Es capital dormido: ni mucho (se vence) ni poco (te quedás sin vender)."
          href="/dashboard/reports/inventario"
        />

        <ReportCard
          title="Stock crítico"
          value={`${data.inventory.outOfStock} sin stock`}
          secondary={`${data.inventory.lowStock} con stock bajo`}
          explanation="Productos agotados o por agotarse. Cada uno sin stock es una venta que perdés. Reponé antes de que pase."
          tone={data.inventory.outOfStock > 0 ? 'danger' : data.inventory.lowStock > 0 ? 'warn' : 'default'}
          href="/dashboard/reports/inventario"
        />

        <ReportCard
          title="Fiados pendientes"
          value={money(data.fiados.totalOwed)}
          secondary={`${data.fiados.clients} clientes · ${data.fiados.highRisk} riesgo alto`}
          explanation="Plata que te deben y todavía no cobraste. Mientras más vieja la deuda, más difícil de recuperar. Cobrá los rojos primero."
          tone={data.fiados.highRisk > 0 ? 'warn' : 'default'}
          href="/dashboard/reports/fiados"
        />

        <ReportCard
          title="Pérdidas (mermas)"
          value={money(data.losses.totalLoss)}
          secondary={`${data.losses.items} registros`}
          explanation="Mercadería que tiraste por vencida, dañada o perdida. Es plata que se fue a la basura: si crece, revisá compras y manejo."
          tone={data.losses.totalLoss > 0 ? 'warn' : 'default'}
          href="/dashboard/reports/perdidas"
        />

        <ReportCard
          title="Flujo de caja neto"
          value={money(data.cashFlow.net)}
          secondary={`gastos ${money(data.cashFlow.expenses)}`}
          explanation="Lo que de verdad entró a tu bolsillo: ventas menos gastos, sueldos y compras. Si da negativo, estás perdiendo plata aunque vendas."
          tone={data.cashFlow.net < 0 ? 'danger' : 'default'}
          href="/dashboard/reports/flujo-caja"
        />

        <ReportCard
          title="Devoluciones"
          value={`${data.returns.rate.toFixed(1)}%`}
          secondary={`${money(data.returns.totalRefunded)} reembolsado`}
          explanation="Qué porcentaje de tus ventas vuelve. Una tasa alta esconde un problema de calidad, precio o proceso que te cuesta plata."
          tone={data.returns.rate > 5 ? 'danger' : data.returns.rate > 2 ? 'warn' : 'default'}
          href="/dashboard/reports/devoluciones"
        />

        <ReportCard
          title="Clientes"
          value={String(data.customers.total)}
          secondary={`${data.customers.inactive} inactivos (+30d)`}
          explanation="Tu base de clientes. Los inactivos hace rato que no compran: un mensaje a tiempo los trae de vuelta antes de perderlos."
          tone={data.customers.inactive > 0 ? 'warn' : 'default'}
          href="/dashboard/reports/clientes"
        />

        <ReportCard
          title="Por vencer (Smart Stock)"
          value={money(data.expiration.atRisk)}
          secondary={`${data.expiration.count} productos en riesgo`}
          explanation="Valor de la mercadería perecedera por vencerse. La IA te sugiere descuentos para venderla antes de tener que tirarla."
          tone={data.expiration.atRisk > 0 ? 'warn' : 'default'}
          href="/dashboard/reports/vencimientos"
        />
      </div>
    </div>
  );
}
