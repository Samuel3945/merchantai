import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { listPaymentMethods } from '@/actions/payment-methods';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getDeliveryKpis, listDeliveries } from '@/features/delivery/actions';
import { DeliveryClient } from '@/features/delivery/DeliveryClient';
import {
  getActiveCourierShift,
  listOpenCajas,
} from '@/features/delivery/shifts';
import { loadEInvoiceConfig } from '@/libs/einvoice/config';

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

  const { orgId } = await auth();
  if (!orgId) {
    redirect('/dashboard');
  }

  const [initial, kpis, activeShift, openCajas, paymentMethods, einvoiceCfg]
    = await Promise.all([
      listDeliveries({ status: 'active' }),
      getDeliveryKpis(),
      getActiveCourierShift(),
      listOpenCajas(),
      listPaymentMethods({ activeOnly: true }),
      loadEInvoiceConfig(orgId),
    ]);

  // The deliver dialog (P0-B) offers the org's real, active payment methods —
  // minus credito: a delivered contraentrega COLLECTS money into a caja, so a
  // credit debt makes no sense there (createDeliverySale rejects it too).
  const deliverPaymentMethods = paymentMethods
    .filter(m => m.type !== 'credit')
    .map(m => ({ name: m.name }));

  return (
    <>
      <TitleBar
        title="Domicilios"
        description="Los pedidos que el domiciliario debe llevar: ver, ejecutar y notificar."
      />
      <DeliveryClient
        initial={initial}
        kpis={kpis}
        initialShift={activeShift}
        openCajas={openCajas}
        paymentMethods={deliverPaymentMethods}
        einvoiceEnabled={einvoiceCfg.configured}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
