import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { fetchClientDetail } from '@/actions/creditos';
import { CreditoDetailClient } from '@/features/creditos/CreditoDetailClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function CreditoDetailPage(props: {
  params: Promise<{ locale: string; clientKey: string }>;
}) {
  const { locale, clientKey } = await props.params;
  setRequestLocale(locale);

  const detail = await fetchClientDetail(decodeURIComponent(clientKey));
  if (!detail) {
    notFound();
  }

  return (
    <>
      <TitleBar
        title={detail.client.name}
        description="Detalle del crédito e historial de movimientos."
      />
      <CreditoDetailClient detail={detail} />
    </>
  );
}

export const dynamic = 'force-dynamic';
