import { setRequestLocale } from 'next-intl/server';
import { getReportsOverview } from '@/actions/reports';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { ReportsOverviewClient } from '@/features/reports/ReportsOverviewClient';

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

export default async function ReportsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const end = todayBogota();
  const start = addDays(end, -29);
  const overview = await getReportsOverview(start, end);

  return (
    <>
      <TitleBar
        title="Reportes"
        description="Todas tus métricas de un vistazo. Toca cualquier tarjeta para ver el detalle."
      />
      <ReportsOverviewClient initial={overview} />
    </>
  );
}

export const dynamic = 'force-dynamic';
