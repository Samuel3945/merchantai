import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { fetchClientDetail } from '@/actions/fiados';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { FiadoDetailClient } from '@/features/fiados/FiadoDetailClient';

export default async function FiadoDetailPage(props: {
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
        description="Detalle del fiado e historial de movimientos."
      />
      <FiadoDetailClient detail={detail} />
    </>
  );
}

export const dynamic = 'force-dynamic';
