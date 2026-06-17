'use client';

import type { OpenCajaOption } from '@/actions/treasury-placement';
import type { PendingHandover, TreasuryAccountRow } from '@/libs/treasury';
import { Clock, Coins, Lock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { money } from '@/features/cash/cash-ui';
import { AllocateModal } from './AllocateModal';

// ── Handover card ─────────────────────────────────────────────────────────────

function HandoverCard(props: {
  handover: PendingHandover;
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
  openCajas: OpenCajaOption[];
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const dateLabel = props.handover.createdAt.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <>
      <div
        className="
          relative flex flex-col gap-0 overflow-hidden rounded-[14px] border
          border-border bg-card transition-[border-color,box-shadow]
          hover:border-warn hover:shadow-sm
        "
      >
        {/* Left warn bar */}
        <span
          className="absolute inset-y-3.5 left-0 w-[3px] rounded-r-full bg-warn"
          aria-hidden
        />

        {/* Card row */}
        <div className="flex items-center gap-4 px-[18px] py-4">
          {/* Icon */}
          <span
            className="
              flex size-[42px] shrink-0 items-center justify-center
              rounded-[11px] bg-warn/10 text-warn
            "
          >
            <Coins className="size-5" />
          </span>

          {/* Origin + meta */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-[650]">{props.handover.origin}</span>
              <span
                className="
                  inline-flex h-5 items-center rounded-full bg-accent px-2.5
                  text-[10.5px] font-semibold text-secondary-foreground
                "
              >
                Pendiente de ubicar
              </span>
            </div>
            <div className="
              mt-1 flex items-center gap-3.5 text-xs text-muted-foreground
            "
            >
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {dateLabel}
              </span>
              {props.handover.cashierName && (
                <span>{props.handover.cashierName}</span>
              )}
            </div>
          </div>

          {/* Amount */}
          <div className="font-display text-[19px] font-[650] tabular-nums">
            {money(props.handover.remaining)}
          </div>

          {/* Ubicar button — opens AllocateModal */}
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => setModalOpen(true)}
          >
            <Lock className="size-3.5" />
            Ubicar
          </Button>
        </div>
      </div>

      <AllocateModal
        handover={props.handover}
        bankAccounts={props.bankAccounts}
        cajaFuerteAccounts={props.cajaFuerteAccounts}
        openCajas={props.openCajas}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}

// ── PorUbicar ─────────────────────────────────────────────────────────────────

type PorUbicarProps = {
  pendingHandovers: PendingHandover[];
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
  openCajas: OpenCajaOption[];
};

/**
 * "Plata por ubicar" section — shown only when there are pending handovers.
 * Header: total sin ubicar + count. One card per handover with an AllocateModal.
 */
export function PorUbicar({ pendingHandovers, bankAccounts, cajaFuerteAccounts, openCajas }: PorUbicarProps) {
  if (pendingHandovers.length === 0) {
    return null;
  }

  const total = pendingHandovers.reduce((s, h) => s + h.remaining, 0);
  const count = pendingHandovers.length;

  return (
    <div className="rounded-xl border border-border bg-card p-[22px] shadow-xs">
      {/* Section header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">
            Plata por ubicar
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Esta plata salió de un cierre y todavía no dijiste dónde quedó.
            Ubicala para no perderle el rastro.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="
            font-display text-[22px] font-[650] text-warn tabular-nums
          "
          >
            {money(total)}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {count}
            {' '}
            {count === 1 ? 'solicitud' : 'solicitudes'}
          </div>
        </div>
      </div>

      {/* Handover cards */}
      <div className="mt-[18px] flex flex-col gap-2.5">
        {pendingHandovers.map(h => (
          <HandoverCard
            key={h.id}
            handover={h}
            bankAccounts={bankAccounts}
            cajaFuerteAccounts={cajaFuerteAccounts}
            openCajas={openCajas}
          />
        ))}
      </div>
    </div>
  );
}
