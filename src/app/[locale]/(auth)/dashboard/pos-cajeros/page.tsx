import { setRequestLocale } from 'next-intl/server';
import { getPosDeviceQuota, listPosTokens } from '@/actions/pos-tokens';
import { listTreasuryAccounts } from '@/actions/treasury';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PosCajerosClient } from '@/features/pos-tokens/PosCajerosClient';

export default async function DashboardPosCajerosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [tokens, quota, allAccounts] = await Promise.all([
    listPosTokens(),
    getPosDeviceQuota(),
    listTreasuryAccounts().catch(() => []),
  ]);

  // Only active caja_fuerte accounts can be sweep destinations.
  const cofres = allAccounts
    .filter(a => a.type === 'caja_fuerte' && a.active)
    .map(a => ({ id: a.id, name: a.name }));

  return (
    <>
      <TitleBar
        title="Cajas POS"
        description="Administra las cajas (dispositivos POS) de tu negocio: genera su acceso y controla cuántas tienes activas según tu plan."
      />
      <PosCajerosClient
        initialTokens={tokens}
        initialQuota={quota}
        initialCofres={cofres}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
