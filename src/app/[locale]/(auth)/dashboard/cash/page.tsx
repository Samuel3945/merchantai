import type { TransferReconciliation } from '@/libs/transfer-reconciliation';
import { setRequestLocale } from 'next-intl/server';
import {
  getFraudAlerts,
  getTodayCollectionsByMethod,
  listOpenCajas,
} from '@/actions/cash';
import { listPaymentMethods } from '@/actions/payment-methods';
import {
  getPendingTransfersOverview,
  getTransferStatusCounts,
  listTransferReconciliations,
} from '@/actions/transfer-reconciliation';
import { CajasSupervision } from '@/features/cash/CajasSupervision';
import { CashTabs } from '@/features/cash/CashTabs';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCashPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [collections, alerts, openCajas, methods] = await Promise.all([
    getTodayCollectionsByMethod(),
    getFraudAlerts(14).catch(() => []),
    listOpenCajas().catch(() => []),
    listPaymentMethods({ activeOnly: true }).catch(() => []),
  ]);

  // No transfer payment methods → the org doesn't deal with transfers at all, so
  // the whole reconciliation surface stays hidden. Don't even fetch it.
  const hasTransferMethods = methods.some(m => m.type === 'transfer');

  let reconciliations: TransferReconciliation[] = [];
  let investigating: TransferReconciliation[] = [];
  // Confirmed + mismatch rows = the editable history of already-verified
  // transfers (the owner may need to correct one). not_arrived stays in its own
  // investigation block.
  let history: TransferReconciliation[] = [];
  let pendingTransfers = { count: 0, total: 0 };
  let transferCounts = { pending: 0, confirmedToday: 0, notArrived: 0 };
  if (hasTransferMethods) {
    const [
      reconResult,
      investigatingResult,
      confirmedResult,
      mismatchResult,
      overviewResult,
      countsResult,
    ] = await Promise.all([
      listTransferReconciliations({ status: 'pending' }).catch(() => null),
      listTransferReconciliations({ status: 'not_arrived' }).catch(() => null),
      listTransferReconciliations({ status: 'confirmed' }).catch(() => null),
      listTransferReconciliations({ status: 'mismatch' }).catch(() => null),
      getPendingTransfersOverview().catch(() => null),
      getTransferStatusCounts().catch(() => null),
    ]);
    reconciliations = reconResult?.ok ? reconResult.data : [];
    investigating = investigatingResult?.ok ? investigatingResult.data : [];
    history = [
      ...(confirmedResult?.ok ? confirmedResult.data : []),
      ...(mismatchResult?.ok ? mismatchResult.data : []),
    ];
    pendingTransfers = overviewResult?.ok
      ? overviewResult.data
      : { count: 0, total: 0 };
    transferCounts = countsResult?.ok ? countsResult.data : transferCounts;
  }

  return (
    <>
      <TitleBar
        title="Caja"
        description="Supervisión de los puntos de cobro: tocá una caja para ver su detalle, movimientos y cierres."
      />
      <div className="mb-6">
        <CajasSupervision
          openCajas={openCajas}
          notArrivedCount={transferCounts.notArrived}
        />
      </div>
      <CashTabs
        cash={{ collections, alerts }}
        hasTransferMethods={hasTransferMethods}
        reconciliations={reconciliations}
        investigating={investigating}
        history={history}
        pendingTransfers={pendingTransfers}
        transferCounts={transferCounts}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
