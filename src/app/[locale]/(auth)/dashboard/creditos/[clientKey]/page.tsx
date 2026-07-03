import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { fetchClientDetail } from '@/actions/creditos';
import { listPaymentMethods } from '@/actions/payment-methods';
import { CreditoDetailClient } from '@/features/creditos/CreditoDetailClient';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { toAbonoMethods } from '@/libs/creditos-shared';

export default async function CreditoDetailPage(props: {
  params: Promise<{ locale: string; clientKey: string }>;
}) {
  const { locale, clientKey } = await props.params;
  setRequestLocale(locale);

  const [detail, methodRows] = await Promise.all([
    fetchClientDetail(decodeURIComponent(clientKey)),
    listPaymentMethods({ activeOnly: true }),
  ]);
  if (!detail) {
    notFound();
  }
  const paymentMethods = toAbonoMethods(methodRows);

  return (
    <>
      <TitleBar
        title={detail.client.name}
        description="Detalle del crédito e historial de movimientos."
      />
      <CreditoDetailClient detail={detail} paymentMethods={paymentMethods} />
    </>
  );
}

export const dynamic = 'force-dynamic';
