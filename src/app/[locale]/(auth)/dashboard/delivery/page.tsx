import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { listPaymentMethods } from '@/actions/payment-methods';
import { TitleBar } from '@/features/dashboard/TitleBar';
import {
  getDeliveryKpis,
  listDeliveries,
  listDeliveriesForCourier,
} from '@/features/delivery/actions';
import { DELIVERY_REQUIRE_PHOTO_KEY } from '@/features/delivery/constants';
import { DeliveryClient } from '@/features/delivery/DeliveryClient';
import {
  getActiveCourierShift,
  listOpenCajas,
} from '@/features/delivery/shifts';
import { loadEInvoiceConfig } from '@/libs/einvoice/config';
import { getCurrentPanelUser } from '@/libs/panel-session';

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

  const { userId, orgId, orgRole } = await auth();
  if (!orgId || !userId) {
    redirect('/dashboard');
  }

  // Role signal (approved model): org:admin gets the control view (all orders +
  // KPIs, with a "Modo repartidor" toggle to switch into the courier layout); a
  // non-admin panel user holding the `delivery` grant gets the courier view
  // (their own POOL + MIS PEDIDOS only). There is no dedicated courier role
  // enum — org:admin vs. non-admin-with-delivery-grant IS the signal.
  const isAdmin = orgRole === 'org:admin';

  // This viewer's own panel-user (pos_users) id — the `courierId` signal for
  // "mis pedidos" AND, for an admin, what a self-claim in "Modo repartidor"
  // stamps on the order (transitionDelivery already resolves the same actor).
  // Null for an admin with no linked employee row — they can still see the
  // control view, just can't self-claim as a courier.
  const viewerCourierId = (await getCurrentPanelUser(userId, orgId))?.id ?? null;

  // Core data + the photo-evidence toggle. Access is already gated
  // (requirePanelModule inside listDeliveries / listDeliveriesForCourier).
  const requirePhotoSetting = await getAppSetting(DELIVERY_REQUIRE_PHOTO_KEY);
  const requirePhoto = requirePhotoSetting.value === 'true';

  const roleData = isAdmin
    ? await (async () => {
        const [initial, kpis] = await Promise.all([
          listDeliveries({ status: 'active' }),
          getDeliveryKpis(),
        ]);
        return { viewerRole: 'admin' as const, initial, kpis };
      })()
    : await (async () => {
        // A non-admin only ever reaches this branch with an active linked
        // pos_users row — requirePanelModule('delivery') (inside
        // listDeliveriesForCourier) resolves the `delivery` grant FROM that
        // same row, so viewerCourierId is guaranteed non-null here. The
        // fallback is defensive only.
        const { pool, mine } = viewerCourierId
          ? await listDeliveriesForCourier(orgId, viewerCourierId)
          : { pool: [], mine: [] };
        return { viewerRole: 'courier' as const, pool, mine };
      })();

  // Settlement lookups degrade gracefully. A failure in ANY one of them — e.g. a
  // not-yet-applied migration (courier_shifts) or e-invoicing not set up — must
  // NOT white-screen the whole Domicilios page; it just disables that one
  // affordance until the underlying cause is fixed.
  const [shiftR, cajasR, methodsR, einvoiceR] = await Promise.allSettled([
    getActiveCourierShift(),
    listOpenCajas(),
    listPaymentMethods({ activeOnly: true }),
    loadEInvoiceConfig(orgId),
  ]);
  const activeShift = shiftR.status === 'fulfilled' ? shiftR.value : null;
  const openCajas = cajasR.status === 'fulfilled' ? cajasR.value : [];
  const paymentMethods = methodsR.status === 'fulfilled' ? methodsR.value : [];
  const einvoiceEnabled
    = einvoiceR.status === 'fulfilled' ? einvoiceR.value.configured : false;

  // The deliver dialog (P0-B) offers the org's real, active payment methods —
  // minus credito: a delivered contraentrega COLLECTS money into a caja, so a
  // credit debt makes no sense there (createDeliverySale rejects it too).
  const deliverPaymentMethods = paymentMethods
    .filter(m => m.type !== 'credit')
    .map(m => ({ name: m.name, type: m.type }));

  return (
    <>
      <TitleBar
        title="Domicilios"
        description="Los pedidos que el domiciliario debe llevar: ver, ejecutar y notificar."
      />
      <DeliveryClient
        {...roleData}
        orgId={orgId}
        viewerCourierId={viewerCourierId}
        initialShift={activeShift}
        openCajas={openCajas}
        paymentMethods={deliverPaymentMethods}
        einvoiceEnabled={einvoiceEnabled}
        requirePhoto={requirePhoto}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
