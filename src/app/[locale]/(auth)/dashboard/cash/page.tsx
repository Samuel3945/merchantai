import type { TransferReconciliation } from '@/libs/transfer-reconciliation';
import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import {
  getFraudAlerts,
  getTodayCollectionsByMethod,
  listCajas,
} from '@/actions/cash';
import { listPaymentMethods } from '@/actions/payment-methods';
import {
  getPendingTransfersOverview,
  getTransferStatusCounts,
  listTransferReconciliations,
} from '@/actions/transfer-reconciliation';
import { CajasSupervision } from '@/features/cash/CajasSupervision';
import { CashClient } from '@/features/cash/CashClient';
import { TransferReconciliationPanel } from '@/features/cash/TransferReconciliationPanel';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCashPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { orgRole } = await auth();
  const isAdmin = orgRole === 'org:admin';

  const [collections, alerts, cajas, methods] = await Promise.all([
    getTodayCollectionsByMethod(),
    getFraudAlerts(14).catch(() => []),
    listCajas().catch(() => []),
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
      resolvedResult,
      overviewResult,
      countsResult,
    ] = await Promise.all([
      listTransferReconciliations({ status: 'pending' }).catch(() => null),
      listTransferReconciliations({ status: 'not_arrived' }).catch(() => null),
      listTransferReconciliations({ status: 'confirmed' }).catch(() => null),
      listTransferReconciliations({ status: 'mismatch' }).catch(() => null),
      // Resolved rows are only shown to admins (recovery surface). Fetch only
      // when needed — cashiers never see this section.
      isAdmin
        ? listTransferReconciliations({ status: 'resolved' }).catch(() => null)
        : Promise.resolve(null),
      getPendingTransfersOverview().catch(() => null),
      getTransferStatusCounts().catch(() => null),
    ]);
    reconciliations = reconResult?.ok ? reconResult.data : [];
    investigating = investigatingResult?.ok ? investigatingResult.data : [];
    history = [
      ...(confirmedResult?.ok ? confirmedResult.data : []),
      ...(mismatchResult?.ok ? mismatchResult.data : []),
      ...(resolvedResult?.ok ? resolvedResult.data : []),
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
      <div className="space-y-8">
        <CajasSupervision
          cajas={cajas}
          notArrivedCount={transferCounts.notArrived}
        />
        <CashClient collections={collections} alerts={alerts} />
        {hasTransferMethods && (
          <TransferReconciliationPanel
            reconciliations={reconciliations}
            investigating={investigating}
            history={history}
            pendingCount={pendingTransfers.count}
            counts={transferCounts}
            isAdmin={isAdmin}
          />
        )}
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
