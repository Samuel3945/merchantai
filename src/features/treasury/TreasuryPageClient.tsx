'use client';

import type { PendingHandover, TreasuryAccount, TreasuryAccountRow } from '@/libs/treasury';
import { useState } from 'react';
import { CreateSlideover } from './CreateSlideover';
import { DeleteAccountModal } from './DeleteAccountModal';
import { MoneyFlow } from './MoneyFlow';
import { PorUbicar } from './PorUbicar';
import { TransferWizard } from './TransferWizard';
import { TreasuryActions } from './TreasuryActions';

type TreasuryPageClientProps = {
  accounts: TreasuryAccount[];
  accountRows: TreasuryAccountRow[];
  pendingHandovers: PendingHandover[];
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
  total: number;
  sinUbicar: number;
  pendingCount: number;
};

/**
 * Client shell for the interactive sections of the Tesorería page.
 * Owns the TransferWizard and CreateSlideover open state so both
 * MoneyFlow (per-place move button) and TreasuryActions (action bar)
 * can trigger them without duplication.
 */
export function TreasuryPageClient({
  accounts,
  accountRows,
  pendingHandovers,
  bankAccounts,
  cajaFuerteAccounts,
  total,
  sinUbicar,
  pendingCount,
}: TreasuryPageClientProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFromKey, setWizardFromKey] = useState<string | undefined>(undefined);
  const [slideoverOpen, setSlideoverOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TreasuryAccount | null>(null);

  function openWizard(fromKey?: string) {
    setWizardFromKey(fromKey);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setWizardFromKey(undefined);
  }

  return (
    <>
      {/* Plata por ubicar */}
      {pendingCount > 0 && (
        <PorUbicar
          pendingHandovers={pendingHandovers}
          bankAccounts={bankAccounts}
          cajaFuerteAccounts={cajaFuerteAccounts}
        />
      )}

      {/* Dónde está la plata — flow diagram */}
      <MoneyFlow
        accounts={accounts}
        total={total}
        sinUbicar={sinUbicar}
        pendingCount={pendingCount}
        onMoveFromPlace={key => openWizard(key)}
        onDeletePlace={account => setDeleteTarget(account)}
        onAddPlace={() => setSlideoverOpen(true)}
      />

      {/* Action bar */}
      <TreasuryActions
        accountRows={accountRows}
        onOpenWizard={() => openWizard()}
        onOpenSlideover={() => setSlideoverOpen(true)}
      />

      {/* TransferWizard — shared */}
      <TransferWizard
        accounts={accounts}
        initFromKey={wizardFromKey}
        open={wizardOpen}
        onClose={closeWizard}
      />

      {/* CreateSlideover — shared */}
      <CreateSlideover
        open={slideoverOpen}
        onClose={() => setSlideoverOpen(false)}
      />

      {/* DeleteAccountModal — caja_fuerte / banco only */}
      <DeleteAccountModal
        account={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
