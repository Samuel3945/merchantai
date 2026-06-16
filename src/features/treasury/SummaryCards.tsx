'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { ArrowLeftRight, Coins, Landmark } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';
import { sumBancos, sumEfectivo } from './utils';

type CardProps = {
  icon: React.ReactNode;
  label: string;
  amount: number;
  hint?: string;
  note?: string;
};

function Card({ icon, label, amount, hint, note }: CardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span className="font-medium">{label}</span>
      </div>
      <div className="mt-2 font-display text-2xl font-semibold tabular-nums">
        {money(amount)}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      )}
      {note && (
        <div className="mt-1 text-[11px] text-muted-foreground italic">{note}</div>
      )}
    </div>
  );
}

/**
 * Three summary cards derived from the SAME TreasuryAccount[] that drives the
 * header total. No additional data fetch permitted (spec: Single Source).
 *
 * - EFECTIVO: Σ type ∈ {caja, caja_fuerte}
 * - BANCOS:   Σ type = banco
 * - EN TRÁNSITO: $0 placeholder until migration 0049 ships (Slice E).
 *   // TODO(slice E): replace with Σ transfer_reconciliations WHERE
 *   // status='confirmed' AND deposit_movement_id IS NULL
 */
export function SummaryCards({ accounts }: { accounts: TreasuryAccount[] }) {
  const efectivo = sumEfectivo(accounts);
  const bancos = sumBancos(accounts);

  // TODO(slice E): wire real EN TRÁNSITO value from getEnTransito() once
  // migration 0049 adds deposit_movement_id to transfer_reconciliations.
  const enTransito = 0;

  return (
    <div className="
      grid grid-cols-1 gap-4
      sm:grid-cols-3
    "
    >
      <Card
        icon={<Coins className="size-4" />}
        label="Efectivo"
        amount={efectivo}
        hint="Cajas POS + caja fuerte"
      />
      <Card
        icon={<Landmark className="size-4" />}
        label="Bancos"
        amount={bancos}
        hint="Cuentas bancarias"
      />
      <Card
        icon={<ArrowLeftRight className="size-4" />}
        label="En tránsito"
        amount={enTransito}
        note="Disponible en Slice E"
      />
    </div>
  );
}
