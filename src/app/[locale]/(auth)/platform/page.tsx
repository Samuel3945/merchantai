import { and, count, eq, gte, sql, sum } from 'drizzle-orm';
import { setRequestLocale } from 'next-intl/server';
import { getPlatformDb } from '@/libs/platform/platform-db';
import {
  businessProfileSchema,
  salesSchema,
  subscriptionsSchema,
} from '@/models/Schema';

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

async function getOverview() {
  const db = await getPlatformDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [businesses, subsByPlan, sales7d] = await Promise.all([
    db.select({ total: count() }).from(businessProfileSchema),
    db
      .select({ plan: subscriptionsSchema.plan, total: count() })
      .from(subscriptionsSchema)
      .where(eq(subscriptionsSchema.active, true))
      .groupBy(subscriptionsSchema.plan),
    db
      .select({
        totalSales: count(),
        revenue: sum(salesSchema.total),
        activeOrgs: sql<number>`count(distinct ${salesSchema.organizationId})`,
      })
      .from(salesSchema)
      .where(
        and(
          eq(salesSchema.status, 'completed'),
          gte(salesSchema.createdAt, sevenDaysAgo),
        ),
      ),
  ]);

  return {
    businessCount: businesses[0]?.total ?? 0,
    subsByPlan,
    sales7d: {
      totalSales: sales7d[0]?.totalSales ?? 0,
      revenue: Number(sales7d[0]?.revenue ?? 0),
      activeOrgs: Number(sales7d[0]?.activeOrgs ?? 0),
    },
  };
}

function StatCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-sm text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-2xl font-bold">{props.value}</div>
      {props.hint
        ? (
            <div className="mt-1 text-xs text-muted-foreground">{props.hint}</div>
          )
        : null}
    </div>
  );
}

export default async function PlatformOverviewPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const overview = await getOverview();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Resumen de la plataforma</h1>
        <p className="text-sm text-muted-foreground">
          Estado global de todos los negocios.
        </p>
      </div>

      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-3
      "
      >
        <StatCard
          label="Negocios"
          value={String(overview.businessCount)}
          hint="Con perfil de negocio capturado"
        />
        <StatCard
          label="Ventas (7 días)"
          value={String(overview.sales7d.totalSales)}
          hint={`${overview.sales7d.activeOrgs} negocios vendiendo`}
        />
        <StatCard
          label="Facturación (7 días)"
          value={COP.format(overview.sales7d.revenue)}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="font-semibold">Suscripciones activas por plan</h2>
        {overview.subsByPlan.length === 0
          ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Ningún negocio tiene una suscripción registrada todavía.
              </p>
            )
          : (
              <ul className="mt-2 space-y-1 text-sm">
                {overview.subsByPlan.map(row => (
                  <li key={row.plan} className="flex justify-between">
                    <span className="capitalize">{row.plan}</span>
                    <span className="font-medium">{row.total}</span>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}
