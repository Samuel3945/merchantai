import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getLowStockItems, getMetrics } from '@/actions/dashboard';
import { fetchFiadosOverview } from '@/actions/fiados';
import { DashboardClient } from '@/features/dashboard/DashboardClient';
import { PlanPanel } from '@/features/dashboard/PlanPanel';

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

export default async function DashboardIndexPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // The Resumen shows business-wide metrics, so it is owner-only. A non-owner
  // member belongs on their personal "Mi día" home. The middleware already
  // enforces this; the guard here keeps getMetrics from ever running for a
  // member and protects against direct server-component hits.
  const { orgRole } = await auth();
  if (orgRole !== 'org:admin') {
    redirect('/dashboard/mi-dia');
  }

  const end = todayBogota();
  const start = addDays(end, -29);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -29);

  // Range metrics drive the chart/KPIs/top-sellers; the fiado + low-stock lists
  // are current state, fetched once here (not in the client's range re-fetch).
  const [metrics, fiado, lowStock] = await Promise.all([
    getMetrics(start, end, prevStart, prevEnd),
    fetchFiadosOverview(),
    getLowStockItems(),
  ]);

  return (
    <>
      <DashboardClient initial={metrics} fiado={fiado} lowStock={lowStock} />
      <div className="mt-6">
        <PlanPanel />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
