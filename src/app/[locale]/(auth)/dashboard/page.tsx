import { setRequestLocale } from 'next-intl/server';
import { getMetrics } from '@/actions/dashboard';
import { DashboardClient } from '@/features/dashboard/DashboardClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

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

  const end = todayBogota();
  const start = addDays(end, -29);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -29);

  const metrics = await getMetrics(start, end, prevStart, prevEnd);

  return (
    <>
      <TitleBar
        title="Resumen"
        description="Ventas, ganancias, inventario y métricas operativas."
      />
      <DashboardClient initial={metrics} />
    </>
  );
}

export const dynamic = 'force-dynamic';
