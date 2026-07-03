import { setRequestLocale } from 'next-intl/server';
import { fetchCreditosOverview } from '@/actions/creditos';
import { listPaymentMethods } from '@/actions/payment-methods';
import { CreditosClient } from '@/features/creditos/CreditosClient';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { toAbonoMethods } from '@/libs/creditos-shared';

export default async function DashboardCreditosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [initial, methodRows] = await Promise.all([
    fetchCreditosOverview(),
    listPaymentMethods({ activeOnly: true }),
  ]);
  const paymentMethods = toAbonoMethods(methodRows);

  return (
    <>
      <TitleBar
        title="Clientes que deben"
        description="Quién te debe, cuánto y cuándo paga. Cobra abonos y extiende plazos."
      />
      <CreditosClient initial={initial} paymentMethods={paymentMethods} />
    </>
  );
}

export const dynamic = 'force-dynamic';
