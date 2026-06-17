'use client';

import type { PaymentMethodRow } from '@/actions/payment-methods';
import type { OpenCajaOption } from '@/actions/treasury-placement';
import type { PendingHandover, TreasuryAccount, TreasuryAccountRow } from '@/libs/treasury';
import { useState } from 'react';
import { CreateSlideover } from './CreateSlideover';
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
  transferMethods: PaymentMethodRow[];
  total: number;
  sinUbicar: number;
  pendingCount: number;
  /** Currently-open POS cajas — passed to AllocateModal for "Volvió a una caja". */
  openCajas: OpenCajaOption[];
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
  transferMethods,
  total,
  sinUbicar,
  pendingCount,
  openCajas,
}: TreasuryPageClientProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFromKey, setWizardFromKey] = useState<string | undefined>(undefined);
  const [slideoverOpen, setSlideoverOpen] = useState(false);

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
          openCajas={openCajas}
        />
      )}

      {/* Dónde está la plata — flow diagram */}
      <MoneyFlow
        accounts={accounts}
        total={total}
        sinUbicar={sinUbicar}
        pendingCount={pendingCount}
        onMoveFromPlace={key => openWizard(key)}
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
        transferMethods={transferMethods}
      />
    </>
  );
}
