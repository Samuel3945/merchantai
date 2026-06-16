'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { ChevronDown, ChevronRight, Coins, Landmark } from 'lucide-react';
import { useState } from 'react';
import { money } from '@/features/cash/cash-ui';
import { groupByType } from './utils';

type BranchProps = {
  label: string;
  icon: React.ReactNode;
  accounts: TreasuryAccount[];
  defaultOpen?: boolean;
};

function Branch({ label, icon, accounts, defaultOpen = true }: BranchProps) {
  const [open, setOpen] = useState(defaultOpen);
  const subtotal = accounts.reduce((acc, a) => acc + a.balance, 0);

  if (accounts.length === 0) {
    return null;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="
          flex w-full items-center justify-between gap-2 rounded-md px-1 py-1.5
          text-left
          hover:bg-muted/50
        "
      >
        <div className="
          flex items-center gap-2 text-sm font-medium text-muted-foreground
        "
        >
          {open
            ? <ChevronDown className="size-3.5" />
            : <ChevronRight className="size-3.5" />}
          {icon}
          {label}
        </div>
        <span className="font-display text-sm font-semibold tabular-nums">
          {money(subtotal)}
        </span>
      </button>

      {open && (
        <div className="mt-1 ml-5 space-y-1 border-l border-border pl-3">
          {accounts.map(a => (
            <div
              key={a.key}
              className="
                flex items-center justify-between rounded-md px-2 py-1.5 text-sm
              "
            >
              <div className="min-w-0">
                <span className="truncate text-foreground">{a.name}</span>
                {a.type === 'caja' && (
                  <span className="
                    ml-1.5 rounded-sm bg-muted px-1 py-0.5 text-[10px]
                    text-muted-foreground
                  "
                  >
                    POS
                  </span>
                )}
                {a.note && (
                  <div className="text-[11px] text-muted-foreground">{a.note}</div>
                )}
              </div>
              <span className="ml-2 shrink-0 font-display text-sm tabular-nums">
                {money(a.balance)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Hierarchical money tree:
 *   EMPRESA → ▼ EFECTIVO (caja + caja_fuerte) → ▼ BANCOS (banco)
 *
 * Each branch is collapsible and shows a subtotal derived from the same leaf
 * accounts, matching the SummaryCards buckets exactly (no double-counting).
 * POS caja leaves are read-only (no actions on individual leaves).
 */
export function MoneyTree({ accounts }: { accounts: TreasuryAccount[] }) {
  const tree = groupByType(accounts);

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay contenedores de tesorería configurados.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <Branch
        label="Efectivo"
        icon={<Coins className="size-3.5" />}
        accounts={tree.efectivo}
        defaultOpen
      />
      <Branch
        label="Bancos"
        icon={<Landmark className="size-3.5" />}
        accounts={tree.bancos}
        defaultOpen
      />
    </div>
  );
}
