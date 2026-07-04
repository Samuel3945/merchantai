import type { CustomerDetail } from '@/features/customers/actions';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { getCustomerDetail } from '@/features/customers/actions';
import { formatSaleNumber } from '@/libs/sale-number';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const shortDateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeZone: 'America/Bogota',
});

const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function money(value: string | number): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? moneyFmt.format(n) : String(value);
}

function initials(name: string | null): string {
  if (!name) {
    return '—';
  }
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '—';
}

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: 'Pedido tomado',
  assigned: 'Tomado por el repartidor',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

// One merged, most-recent-first stream over the three ledgers, so the profile
// reads as a single history the way a tendero thinks about a client.
type TimelineEntry = {
  key: string;
  date: Date;
  title: string;
  subtitle: string | null;
  amount: string | number | null;
  tone: 'sale' | 'abono' | 'delivery';
  href?: string;
  badge?: { label: string; cls: string };
};

function buildTimeline(detail: CustomerDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const s of detail.recentSales) {
    entries.push({
      key: `sale-${s.id}`,
      date: s.date,
      title: `Compra ${formatSaleNumber(s.saleNumber)}`,
      subtitle: s.paymentType,
      amount: s.total,
      tone: 'sale',
      href: `/dashboard/sales/${s.id}`,
      badge: s.fullyReturned
        ? {
            label: 'Devuelta',
            cls: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
          }
        : undefined,
    });
  }

  for (const a of detail.credito.recentAbonos) {
    entries.push({
      key: `abono-${a.id}`,
      date: a.date,
      title: `Abono a crédito${a.method ? ` — ${a.method}` : ''}`,
      subtitle: 'Pago de crédito',
      amount: a.amount,
      tone: 'abono',
    });
  }

  for (const d of detail.deliveries) {
    entries.push({
      key: `delivery-${d.id}`,
      date: d.date,
      title: 'Domicilio',
      subtitle: DELIVERY_STATUS_LABELS[d.status] ?? d.status,
      amount: d.total,
      tone: 'delivery',
    });
  }

  return entries.sort((a, b) => b.date.getTime() - a.date.getTime());
}

const TONE_DOT: Record<TimelineEntry['tone'], string> = {
  sale: 'border-emerald-500 bg-emerald-500',
  abono: 'border-teal-500 bg-teal-500',
  delivery: 'border-sky-500 bg-sky-500',
};

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default async function CustomerDetailPage(props: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await props.params;
  setRequestLocale(locale);

  const detail = await getCustomerDetail(id);
  if (!detail) {
    notFound();
  }

  const { profile, kpis } = detail;
  const timeline = buildTimeline(detail);
  const contact = [profile.whatsapp, profile.documentId, profile.email]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-6">
      {/* Header: back link, avatar, name, contact, debt chip */}
      <div>
        <Link
          href="/dashboard/customers"
          className="
            text-sm text-muted-foreground
            hover:text-primary hover:underline
          "
        >
          ← Clientes
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <span className="
            flex size-14 shrink-0 items-center justify-center rounded-full
            bg-muted text-lg font-semibold text-muted-foreground
          "
          >
            {initials(profile.name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-3xl font-medium tracking-tight">
                {profile.name}
              </h1>
              {kpis.creditBalance > 0 && (
                <Badge
                  variant="outline"
                  className="
                    border-red-500/30 bg-red-500/10 text-red-600
                    dark:text-red-400
                  "
                >
                  Debe
                  {' '}
                  {money(kpis.creditBalance)}
                </Badge>
              )}
            </div>
            {contact && (
              <p className="mt-1 text-sm text-muted-foreground">{contact}</p>
            )}
            {profile.address && (
              <p className="text-sm text-muted-foreground">{profile.address}</p>
            )}
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="
        grid grid-cols-2 gap-3
        lg:grid-cols-4
      "
      >
        <Kpi label="Total gastado" value={money(kpis.totalSpent)} />
        <Kpi label="Compras" value={kpis.purchaseCount} />
        <Kpi label="Ticket promedio" value={money(kpis.avgTicket)} />
        <Kpi
          label="Última compra"
          value={
            kpis.lastPurchaseAt
              ? shortDateFmt.format(kpis.lastPurchaseAt)
              : '—'
          }
        />
      </div>

      {/* Timeline */}
      <div className="rounded-lg border bg-background shadow-xs">
        <div className="border-b px-4 py-3 text-sm font-semibold">
          Historial
        </div>
        {timeline.length === 0
          ? (
              <div className="
                px-4 py-10 text-center text-sm text-muted-foreground
              "
              >
                Aún no hay movimientos para este cliente.
              </div>
            )
          : (
              <ol className="divide-y">
                {timeline.map((e) => {
                  const body = (
                    <div className="flex items-start gap-3 px-4 py-3">
                      <span
                        className={`
                          mt-1.5 size-3 shrink-0 rounded-full border-2
                          ${TONE_DOT[e.tone]}
                        `}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{e.title}</span>
                          {e.badge && (
                            <Badge variant="outline" className={e.badge.cls}>
                              {e.badge.label}
                            </Badge>
                          )}
                        </div>
                        {e.subtitle && (
                          <div className="text-xs text-muted-foreground">
                            {e.subtitle}
                          </div>
                        )}
                        <div className="
                          mt-0.5 text-[11px] text-muted-foreground tabular-nums
                        "
                        >
                          {dateTimeFmt.format(e.date)}
                        </div>
                      </div>
                      {e.amount != null && (
                        <span className="
                          shrink-0 text-sm font-medium tabular-nums
                        "
                        >
                          {money(e.amount)}
                        </span>
                      )}
                    </div>
                  );
                  return e.href
                    ? (
                        <li key={e.key} className="hover:bg-muted/40">
                          <Link href={e.href} className="block">
                            {body}
                          </Link>
                        </li>
                      )
                    : (
                        <li key={e.key}>{body}</li>
                      );
                })}
              </ol>
            )}
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
