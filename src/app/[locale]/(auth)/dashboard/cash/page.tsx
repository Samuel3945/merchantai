import { setRequestLocale } from 'next-intl/server';
import {
  getCashSecurityStatus,
  getCurrentCash,
  getFraudAlerts,
  getTodayCashKpis,
  listAllCashMovements,
  listCashSessions,
} from '@/actions/cash';
import { CashClient } from '@/features/cash/CashClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCashPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [current, sessions, alerts, kpis, security, history] = await Promise.all([
    getCurrentCash(),
    listCashSessions(30),
    getFraudAlerts(14).catch(() => []),
    getTodayCashKpis(),
    getCashSecurityStatus(),
    listAllCashMovements(1000),
  ]);

  return (
    <>
      <TitleBar
        title="Caja"
        description="Abre y cierra la caja, registra movimientos y haz el arqueo del día."
      />
      <CashClient
        current={current}
        sessions={sessions}
        alerts={alerts}
        kpis={kpis}
        security={security}
        history={history}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
