import { setRequestLocale } from 'next-intl/server';
import { listOrgCashiers, listPosTokens } from '@/actions/pos-tokens';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PosCajerosClient } from '@/features/pos-tokens/PosCajerosClient';

export default async function DashboardPosCajerosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [tokens, cashiers] = await Promise.all([
    listPosTokens(),
    listOrgCashiers(),
  ]);

  return (
    <>
      <TitleBar
        title="POS Cajeros"
        description="Genera y administra los tokens que autentican los dispositivos de caja."
      />
      <PosCajerosClient initialTokens={tokens} initialCashiers={cashiers} />
    </>
  );
}

export const dynamic = 'force-dynamic';
