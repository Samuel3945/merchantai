'use client';

import { useState } from 'react';
import { cn } from '@/utils/Helpers';

const fmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: number): string {
  return fmt.format(value);
}

/**
 * Colombian peso denominations in circulation, highest first.
 * Bills: 100k–2k. Coins: 1k–50. The cashier counts how many of each
 * they have; the component multiplies and sums so they reach the total
 * without doing the math by hand.
 */
const DENOMINATIONS = [
  100_000,
  50_000,
  20_000,
  10_000,
  5_000,
  2_000,
  1_000,
  500,
  200,
  100,
  50,
] as const;

const qtyInputCls
  = 'h-8 w-16 rounded-md border border-input bg-card px-2 text-right text-sm tabular-nums outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&[type=number]]:[-moz-appearance:textfield]';

function computeTotal(counts: Record<number, string>): number {
  return DENOMINATIONS.reduce((sum, denom) => {
    const qty = Number.parseInt(counts[denom] ?? '', 10);
    return Number.isFinite(qty) && qty > 0 ? sum + qty * denom : sum;
  }, 0);
}

/**
 * Optional cash-counting assistant. The cashier expands it, enters how many
 * bills/coins of each denomination they have, and the running total is pushed
 * to the parent via `onTotal` so it fills the amount field. Pure helper — it
 * does not persist the breakdown, only computes the total.
 */
export function DenominationCounter(props: {
  onTotal: (total: number) => void;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});

  const total = computeTotal(counts);

  function handleChange(denom: number, raw: string) {
    const cleaned = raw.replace(/\D/g, '');
    const next = { ...counts, [denom]: cleaned };
    setCounts(next);
    props.onTotal(computeTotal(next));
  }

  function clear() {
    setCounts({});
    props.onTotal(0);
  }

  return (
    <div className={props.className}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="
          flex items-center gap-1 text-sm font-medium text-primary
          hover:underline
        "
        aria-expanded={open}
      >
        <span className={cn('transition-transform', open && 'rotate-90')}>›</span>
        {props.label ?? 'Contar billetes'}
      </button>

      {open && (
        <div className="
          mt-2 space-y-1 rounded-lg border border-border bg-background p-3
        "
        >
          {DENOMINATIONS.map((denom) => {
            const qty = Number.parseInt(counts[denom] ?? '', 10);
            const subtotal = Number.isFinite(qty) && qty > 0 ? qty * denom : 0;
            return (
              <div key={denom} className="flex items-center gap-2 text-sm">
                <span className="
                  w-20 shrink-0 text-muted-foreground tabular-nums
                "
                >
                  {money(denom)}
                </span>
                <span className="text-muted-foreground">×</span>
                <input
                  className={qtyInputCls}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  placeholder="0"
                  value={counts[denom] ?? ''}
                  onChange={e => handleChange(denom, e.target.value)}
                  aria-label={`Cantidad de ${money(denom)}`}
                />
                <span className="ml-auto tabular-nums">
                  {subtotal > 0 ? money(subtotal) : '—'}
                </span>
              </div>
            );
          })}

          <div className="
            mt-2 flex items-center justify-between border-t border-border pt-2
          "
          >
            <button
              type="button"
              onClick={clear}
              className="
                text-xs text-muted-foreground
                hover:text-foreground hover:underline
              "
            >
              Limpiar
            </button>
            <div className="text-sm">
              <span className="text-muted-foreground">Total contado: </span>
              <span className="font-semibold tabular-nums">{money(total)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
