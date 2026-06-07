import { setRequestLocale } from 'next-intl/server';
import { fetchFiadosOverview } from '@/actions/fiados';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { FiadosClient } from '@/features/fiados/FiadosClient';

export default async function DashboardFiadosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await fetchFiadosOverview();

  return (
    <>
      <TitleBar
        title="Clientes que deben"
        description="Quién te debe, cuánto y cuándo paga. Cobra abonos y extiende plazos."
      />
      <FiadosClient initial={initial} />
    </>
  );
}

export const dynamic = 'force-dynamic';
