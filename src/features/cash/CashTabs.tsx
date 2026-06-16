'use client';

import type { TransferReconciliation } from '@/libs/transfer-reconciliation';
import { useState } from 'react';
import { cn } from '@/utils/Helpers';
import { CashClient } from './CashClient';
import { TransferReconciliationPanel } from './TransferReconciliationPanel';

type View = 'arqueo' | 'transferencias';

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'rounded-md px-3 py-1.5 font-medium transition-colors',
        props.active
          ? 'bg-card text-foreground shadow-xs'
          : `
            text-muted-foreground
            hover:text-foreground
          `,
      )}
    >
      {props.children}
    </button>
  );
}

// Wraps the untouched CashClient (efectivo arqueo) and the transfer
// reconciliation panel behind a tab. The cash arqueo and the transfer
// reconciliation are two separate acts with different owners, so they live
// side by side under the same Caja module instead of being merged.
export function CashTabs(props: {
  cash: React.ComponentProps<typeof CashClient>;
  hasTransferMethods: boolean;
  reconciliations: TransferReconciliation[];
  investigating: TransferReconciliation[];
  pendingTransfers: { count: number; total: number };
  transferCounts: { pending: number; confirmedToday: number; notArrived: number };
}) {
  const [view, setView] = useState<View>('arqueo');

  // No transfer payment methods → no transfers to reconcile. Skip the tab
  // entirely; the owner only sees the collections summary.
  if (!props.hasTransferMethods) {
    return <CashClient {...props.cash} />;
  }

  return (
    <div className="space-y-6">
      <div className="
        inline-flex rounded-lg border border-border bg-muted/40 p-1 text-sm
      "
      >
        <TabButton active={view === 'arqueo'} onClick={() => setView('arqueo')}>
          Resumen
        </TabButton>
        <TabButton
          active={view === 'transferencias'}
          onClick={() => setView('transferencias')}
        >
          Transferencias
          {props.pendingTransfers.count > 0 && (
            <span className="
              ml-2 rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium
              text-primary-foreground
            "
            >
              {props.pendingTransfers.count}
            </span>
          )}
        </TabButton>
      </div>

      {view === 'arqueo'
        ? <CashClient {...props.cash} />
        : (
            <TransferReconciliationPanel
              reconciliations={props.reconciliations}
              investigating={props.investigating}
              pendingCount={props.pendingTransfers.count}
              pendingTotal={props.pendingTransfers.total}
              counts={props.transferCounts}
            />
          )}
    </div>
  );
}
