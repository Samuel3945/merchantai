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
  listTransferReconciliations,
} from '@/actions/transfer-reconciliation';
import { getTreasury, listTreasuryAccounts } from '@/actions/treasury';
import { CashTabs } from '@/features/cash/CashTabs';
import { TreasuryConsole } from '@/features/cash/TreasuryConsole';
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
    treasury,
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
    getTreasury().catch(() => []),
    // 2C: full account rows (with UUIDs) needed by Consignar and MovementModal.
    listTreasuryAccounts().catch(() => []),
  ]);

  // No transfer payment methods → the org doesn't deal with transfers at all, so
  // the whole reconciliation surface stays hidden. Don't even fetch it.
  const hasTransferMethods = methods.some(m => m.type === 'transfer');

  let reconciliations: TransferReconciliation[] = [];
  let investigating: TransferReconciliation[] = [];
  let pendingTransfers = { count: 0, total: 0 };
  if (hasTransferMethods) {
    const [reconResult, investigatingResult, overviewResult] = await Promise.all([
      listTransferReconciliations({ status: 'pending' }).catch(() => null),
      listTransferReconciliations({ status: 'not_arrived' }).catch(() => null),
      getPendingTransfersOverview().catch(() => null),
    ]);
    reconciliations = reconResult?.ok ? reconResult.data : [];
    investigating = investigatingResult?.ok ? investigatingResult.data : [];
    pendingTransfers = overviewResult?.ok
      ? overviewResult.data
      : { count: 0, total: 0 };
  }

  return (
    <>
      <TitleBar
        title="Caja"
        description="Abre y cierra la caja, registra movimientos y haz el arqueo del día."
      />
      <div className="mb-6">
        <TreasuryConsole
          accounts={treasury}
          accountRows={treasuryAccountRows}
          transferMethods={methods}
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
        treasuryAccounts={treasuryAccountRows}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
