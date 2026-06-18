'use client';

import type { RecoverableLoss } from '@/libs/cash-loss';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { money } from '@/features/cash/cash-ui';
import { RecoverLossModal } from './RecoverLossModal';

// ── Loss card ─────────────────────────────────────────────────────────────────

function LossCard(props: {
  loss: RecoverableLoss;
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const dateLabel = props.loss.incurredOn;

  return (
    <>
      <div
        className="
          relative flex flex-col gap-0 overflow-hidden rounded-[14px] border
          border-border bg-card transition-[border-color,box-shadow]
          hover:border-destructive/50 hover:shadow-sm
        "
      >
        {/* Left bar */}
        <span
          className="
            absolute inset-y-3.5 left-0 w-[3px] rounded-r-full bg-destructive
          "
          aria-hidden
        />

        <div className="flex items-center gap-4 px-[18px] py-4">
          {/* Icon */}
          <span
            className="
              flex size-[42px] shrink-0 items-center justify-center
              rounded-[11px] bg-destructive/10 text-destructive
            "
          >
            <AlertTriangle className="size-5" />
          </span>

          {/* Description + date */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-[650]">
                {props.loss.description ?? 'Faltante de efectivo'}
              </span>
              <span
                className="
                  inline-flex h-5 items-center rounded-full bg-destructive/10
                  px-2.5 text-[10.5px] font-semibold text-destructive
                "
              >
                Pérdida
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {dateLabel}
            </div>
          </div>

          {/* Amount */}
          <div className="
            font-display text-[19px] font-[650] text-destructive tabular-nums
          "
          >
            -
            {money(props.loss.amount)}
          </div>

          {/* Recover button */}
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setModalOpen(true)}
          >
            <RotateCcw className="size-3.5" />
            Apareció
          </Button>
        </div>
      </div>

      <RecoverLossModal
        loss={props.loss}
        bankAccounts={props.bankAccounts}
        cajaFuerteAccounts={props.cajaFuerteAccounts}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}

// ── FaltantesSection ──────────────────────────────────────────────────────────

type FaltantesSectionProps = {
  losses: RecoverableLoss[];
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
};

/**
 * "Faltantes / Pérdidas" section — shown only when there are recoverable losses.
 * Each card shows a faltante expense with an "Apareció" button to open RecoverLossModal.
 */
export function FaltantesSection({ losses, bankAccounts, cajaFuerteAccounts }: FaltantesSectionProps) {
  if (losses.length === 0) {
    return null;
  }

  const total = losses.reduce((s, l) => s + l.amount, 0);
  const count = losses.length;

  return (
    <div className="
      rounded-xl border border-destructive/30 bg-card p-[22px] shadow-xs
    "
    >
      {/* Section header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">
            Faltantes / Pérdidas
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Si la plata apareció, marcala como recuperada. Eso revierte la pérdida y
            sube la utilidad de vuelta.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="
            font-display text-[22px] font-[650] text-destructive tabular-nums
          "
          >
            -
            {money(total)}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {count}
            {' '}
            {count === 1 ? 'faltante' : 'faltantes'}
          </div>
        </div>
      </div>

      {/* Loss cards */}
      <div className="mt-[18px] flex flex-col gap-2.5">
        {losses.map(l => (
          <LossCard
            key={l.id}
            loss={l}
            bankAccounts={bankAccounts}
            cajaFuerteAccounts={cajaFuerteAccounts}
          />
        ))}
      </div>
    </div>
  );
}
