import { setRequestLocale } from 'next-intl/server';
import { listOrgAddresses } from '@/actions/org-addresses';
import {
  getPosDeviceQuota,
  listOrgCashiers,
  listPosTokens,
} from '@/actions/pos-tokens';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PosCajerosClient } from '@/features/pos-tokens/PosCajerosClient';

export default async function DashboardPosCajerosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [tokens, cashiers, quota, addresses] = await Promise.all([
    listPosTokens(),
    listOrgCashiers(),
    getPosDeviceQuota(),
    listOrgAddresses(),
  ]);

  return (
    <>
      <TitleBar
        title="Cajas POS"
        description="Administra las cajas (dispositivos POS) de tu negocio: genera su acceso, vincula al cajero, asigna su sucursal y controla cuántas tienes activas según tu plan."
      />
      <PosCajerosClient
        initialTokens={tokens}
        initialCashiers={cashiers}
        initialQuota={quota}
        initialAddresses={addresses}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
