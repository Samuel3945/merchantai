'use client';

import type { ReactNode } from 'react';
import type { TreasuryAccount } from '@/libs/treasury';
import { ChevronDown, Coins, Landmark, Lock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { money } from './cash-ui';
import { Consignar } from './Consignar';

const GROUPS: { type: TreasuryAccount['type']; label: string }[] = [
  { type: 'caja', label: 'Cajas' },
  { type: 'caja_fuerte', label: 'Caja fuerte' },
  { type: 'banco', label: 'Cuentas bancarias' },
];

function sum(items: TreasuryAccount[]): number {
  return items.reduce((acc, a) => acc + a.balance, 0);
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// One compact card for the always-visible summary strip.
function SummaryCard(props: {
  icon: ReactNode;
  label: string;
  amount: number;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`
        rounded-lg border p-3
        ${
    props.highlight
      ? 'border-primary/20 bg-primary/5'
      : 'border-border bg-background'
    }
      `}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {props.icon}
        <span className="truncate">{props.label}</span>
      </div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums">
        {money(props.amount)}
      </div>
      {props.hint && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {props.hint}
        </div>
      )}
    </div>
  );
}

// The owner's treasury overview. A dense summary strip up top (totals per
// container kind + grand total) with the per-container breakdown available
// on demand, so the position is readable at a glance instead of a wall of
// half-empty cards.
export function TreasuryConsole(props: { accounts: TreasuryAccount[] }) {
  const [showDetail, setShowDetail] = useState(false);

  if (props.accounts.length === 0) {
    return null;
  }

  const banks = props.accounts
    .filter(a => a.type === 'banco')
    .map(a => ({ value: a.name, label: a.name }));

  const cajas = props.accounts.filter(a => a.type === 'caja');
  const safe = props.accounts.filter(a => a.type === 'caja_fuerte');
  const banco = props.accounts.filter(a => a.type === 'banco');
  const total = sum(props.accounts);

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Dónde está la plata</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Saldo de cada lugar donde tenés dinero.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowDetail(v => !v)}
          aria-expanded={showDetail}
          className="
            flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs
            font-medium text-primary
            hover:bg-primary/5
          "
        >
          {showDetail ? 'Ocultar detalle' : 'Ver detalle'}
          <ChevronDown
            className={`
              size-3.5 transition-transform
              ${
    showDetail ? 'rotate-180' : ''
    }
            `}
          />
        </button>
      </div>

      <div className="
        mt-4 grid grid-cols-2 gap-3
        lg:grid-cols-4
      "
      >
        <SummaryCard
          highlight
          icon={<Wallet className="size-3.5" />}
          label="Plata total"
          amount={total}
        />
        {cajas.length > 0 && (
          <SummaryCard
            icon={<Coins className="size-3.5" />}
            label="Efectivo"
            amount={sum(cajas)}
            hint={countLabel(cajas.length, 'caja', 'cajas')}
          />
        )}
        {safe.length > 0 && (
          <SummaryCard
            icon={<Lock className="size-3.5" />}
            label="Caja fuerte"
            amount={sum(safe)}
          />
        )}
        {banco.length > 0 && (
          <SummaryCard
            icon={<Landmark className="size-3.5" />}
            label="Bancos"
            amount={sum(banco)}
            hint={countLabel(banco.length, 'cuenta', 'cuentas')}
          />
        )}
      </div>

      {showDetail && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {GROUPS.map((g) => {
            const items = props.accounts.filter(a => a.type === g.type);
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={g.type}>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {g.label}
                </div>
                <div className="
                  grid grid-cols-2 gap-3
                  lg:grid-cols-4
                "
                >
                  {items.map(a => (
                    <div
                      key={a.key}
                      className="
                        rounded-lg border border-border bg-background p-3
                      "
                    >
                      <div className="truncate text-xs text-muted-foreground">
                        {a.name}
                      </div>
                      <div className="
                        mt-1 font-display text-lg font-medium tabular-nums
                      "
                      >
                        {money(a.balance)}
                      </div>
                      {a.note && (
                        <div className="
                          mt-0.5 text-[11px] text-muted-foreground
                        "
                        >
                          {a.note}
                        </div>
                      )}
                      {a.type === 'caja_fuerte' && <Consignar banks={banks} />}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
