import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getDeliveryKpis, listDeliveries } from '@/features/delivery/actions';
import { DeliveryClient } from '@/features/delivery/DeliveryClient';

export default async function DashboardDeliveryPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Domicilios rides with the AI preview (the agent's phase-2 use case) —
  // operator-gated, default OFF. Guard the route so a direct hit bounces when
  // it's disabled.
  const aiSetting = await getAppSetting('modules.ai');
  if (aiSetting.value !== 'true') {
    redirect('/dashboard');
  }

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
