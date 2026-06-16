import type { TransferReconciliation } from '@/libs/transfer-reconciliation';
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
import { listPaymentMethods } from '@/actions/payment-methods';
import {
  getPendingTransfersOverview,
  getTransferStatusCounts,
  listTransferReconciliations,
} from '@/actions/transfer-reconciliation';
import { listTreasuryAccounts } from '@/actions/treasury';
import { CajasSupervision } from '@/features/cash/CajasSupervision';
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
    methods,
    treasuryAccountRows,
  ] = await Promise.all([
    getCurrentCash(),
    listCashSessions(2000),
    getFraudAlerts(14).catch(() => []),
    getTodayCashKpis(),
    getCashSecurityStatus(),
    listAllCashMovements(1000),
    listOpenCajas().catch(() => []),
    listPaymentMethods({ activeOnly: true }).catch(() => []),
    // Full account rows (with UUIDs) needed by the caja movement modal.
    listTreasuryAccounts().catch(() => []),
  ]);

  // No transfer payment methods → the org doesn't deal with transfers at all, so
  // the whole reconciliation surface stays hidden. Don't even fetch it.
  const hasTransferMethods = methods.some(m => m.type === 'transfer');

  let reconciliations: TransferReconciliation[] = [];
  let investigating: TransferReconciliation[] = [];
  let pendingTransfers = { count: 0, total: 0 };
  let transferCounts = { pending: 0, confirmedToday: 0, notArrived: 0 };
  if (hasTransferMethods) {
    const [reconResult, investigatingResult, overviewResult, countsResult]
      = await Promise.all([
        listTransferReconciliations({ status: 'pending' }).catch(() => null),
        listTransferReconciliations({ status: 'not_arrived' }).catch(() => null),
        getPendingTransfersOverview().catch(() => null),
        getTransferStatusCounts().catch(() => null),
      ]);
    reconciliations = reconResult?.ok ? reconResult.data : [];
    investigating = investigatingResult?.ok ? investigatingResult.data : [];
    pendingTransfers = overviewResult?.ok
      ? overviewResult.data
      : { count: 0, total: 0 };
    transferCounts = countsResult?.ok ? countsResult.data : transferCounts;
  }

  // Today's net cash difference across sessions closed today (America/Bogota),
  // the same calendar day the closures history groups by.
  const bogotaDay = (value: Date | string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      new Date(value),
    );
  const today = bogotaDay(new Date());
  const diferenciasHoy = sessions
    .filter(s => s.status === 'closed' && s.closedAt && bogotaDay(s.closedAt) === today)
    .reduce((sum, s) => sum + (Number.parseFloat(s.difference ?? '0') || 0), 0);

  return (
    <>
      <TitleBar
        title="Caja"
        description="Supervisión de puntos de cobro: estado de cada caja, arqueos y diferencias."
      />
      <div className="mb-6">
        <CajasSupervision
          openCajas={openCajas}
          diferenciasHoy={diferenciasHoy}
          pendingCount={pendingTransfers.count}
        />
      </div>
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
        hasTransferMethods={hasTransferMethods}
        reconciliations={reconciliations}
        investigating={investigating}
        pendingTransfers={pendingTransfers}
        transferCounts={transferCounts}
        treasuryAccounts={treasuryAccountRows}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
