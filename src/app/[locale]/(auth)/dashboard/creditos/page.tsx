import { setRequestLocale } from 'next-intl/server';
import { fetchCreditosOverview } from '@/actions/creditos';
import { CreditosClient } from '@/features/creditos/CreditosClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCreditosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await fetchCreditosOverview();

  return (
    <>
      <TitleBar
        title="Clientes que deben"
        description="Quién te debe, cuánto y cuándo paga. Cobra abonos y extiende plazos."
      />
      <CreditosClient initial={initial} />
    </>
  );
}

export const dynamic = 'force-dynamic';
