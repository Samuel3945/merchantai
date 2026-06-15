import { setRequestLocale } from 'next-intl/server';
import {
  getCashSecurityStatus,
  getCurrentCash,
  getFraudAlerts,
  getTodayCashKpis,
  listAllCashMovements,
  listCashSessions,
  listOpenCajas,
} from '@/actions/cash';
import {
  getPendingTransfersOverview,
  listTransferReconciliations,
} from '@/actions/transfer-reconciliation';
import { CashTabs } from '@/features/cash/CashTabs';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCashPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [
    current,
    sessions,
    alerts,
    kpis,
    security,
    history,
    openCajas,
    reconResult,
    overviewResult,
  ] = await Promise.all([
    getCurrentCash(),
    listCashSessions(2000),
    getFraudAlerts(14).catch(() => []),
    getTodayCashKpis(),
    getCashSecurityStatus(),
    listAllCashMovements(1000),
    listOpenCajas().catch(() => []),
    listTransferReconciliations({ status: 'pending' }).catch(() => null),
    getPendingTransfersOverview().catch(() => null),
  ]);

  const reconciliations = reconResult?.ok ? reconResult.data : [];
  const pendingTransfers = overviewResult?.ok
    ? overviewResult.data
    : { count: 0, total: 0 };

  return (
    <>
      <TitleBar
        title="Caja"
        description="Abre y cierra la caja, registra movimientos y haz el arqueo del día."
      />
      <CashTabs
        cash={{
          current,
          sessions,
          alerts,
          kpis,
          security,
          history,
          openCajas,
        }}
        reconciliations={reconciliations}
        pendingTransfers={pendingTransfers}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
