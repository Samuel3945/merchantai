import { setRequestLocale } from 'next-intl/server';
import { listCajas } from '@/actions/cajas';
import { getPosDeviceQuota, listPosTokens } from '@/actions/pos-tokens';
import { listTreasuryAccounts } from '@/actions/treasury';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PosCajerosClient } from '@/features/pos-tokens/PosCajerosClient';

export default async function DashboardPosCajerosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [tokens, quota, allAccounts, cajas] = await Promise.all([
    listPosTokens(),
    getPosDeviceQuota(),
    listTreasuryAccounts().catch(() => []),
    listCajas().catch(() => ({ cajas: [], couriersWithoutCaja: [] })),
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
        initialCajas={cajas.cajas}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
