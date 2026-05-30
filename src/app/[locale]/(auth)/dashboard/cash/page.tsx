import { setRequestLocale } from 'next-intl/server';
import { getCurrentCash, getFraudAlerts, listCashSessions } from '@/actions/cash';
import { CashClient } from '@/features/cash/CashClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCashPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [current, sessions, alerts] = await Promise.all([
    getCurrentCash(),
    listCashSessions(30),
    getFraudAlerts(14).catch(() => []),
  ]);

  return (
    <>
      <TitleBar
        title="Caja"
        description="Abre y cierra la caja, registra movimientos y haz el arqueo del día."
      />
      <CashClient current={current} sessions={sessions} alerts={alerts} />
    </>
  );
}

export const dynamic = 'force-dynamic';
