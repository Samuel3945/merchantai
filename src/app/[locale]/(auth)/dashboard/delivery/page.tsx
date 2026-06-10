import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getDeliveryKpis, listDeliveries } from '@/features/delivery/actions';
import { DeliveryClient } from '@/features/delivery/DeliveryClient';

export default async function DashboardDeliveryPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [initial, kpis] = await Promise.all([
    listDeliveries({ status: 'active' }),
    getDeliveryKpis(),
  ]);

  return (
    <>
      <TitleBar
        title="Domicilios"
        description="Los pedidos que el domiciliario debe llevar: ver, ejecutar y notificar."
      />
      <DeliveryClient initial={initial} kpis={kpis} />
    </>
  );
}

export const dynamic = 'force-dynamic';
