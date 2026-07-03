'use client';

import { formatMoney } from './ui';

// Percentage shortcuts of the outstanding balance, like the cashier POS.
const PERCENTS = [0.25, 0.5, 0.75, 1] as const;

// Amount input for an abono, ported from pos-merchatai: a text field (no number
// spinners) with a "$" adornment, quick percent buttons and a live "quedará
// pendiente" hint.
export function AbonoAmountField({
  value,
  onChange,
  balance,
  id,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  balance: number;
  id?: string;
  autoFocus?: boolean;
}) {
  const amount = Number.parseFloat(value);
  const remaining
    = Number.isFinite(amount) && amount > 0
      ? Math.max(0, balance - amount)
      : null;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-medium text-muted-foreground"
      >
        Monto del abono
        {' '}
        <span className="font-normal">
          (saldo
          {' '}
          {formatMoney(balance)}
          )
        </span>
      </label>
      <div className="relative mt-1.5">
        <span className="
          pointer-events-none absolute top-1/2 left-3 -translate-y-1/2
          font-semibold text-muted-foreground
        "
        >
          $
        </span>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0"
          autoFocus={autoFocus}
          className="
            h-11 w-full rounded-lg border border-input bg-card pr-3 pl-7 text-lg
            font-semibold tabular-nums outline-none
            focus-visible:border-primary focus-visible:ring-2
            focus-visible:ring-ring/30
          "
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PERCENTS.map((frac) => {
          const v = Math.round(balance * frac);
          return (
            <button
              key={frac}
              type="button"
              onClick={() => onChange(String(v))}
              className="
                rounded-md border border-input bg-card px-2.5 py-1 text-xs
                text-muted-foreground transition-colors
                hover:border-primary hover:text-foreground
              "
            >
              {frac === 1 ? 'Todo' : `${frac * 100}%`}
            </button>
          );
        })}
      </div>
      {remaining != null && remaining > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Quedará pendiente:
          {' '}
          <span className="font-medium text-foreground">
            {formatMoney(remaining)}
          </span>
        </p>
      )}
    </div>
  );
}
