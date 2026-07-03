'use client';

import type { AbonoMethod, AbonoMethodType } from '@/libs/creditos-shared';
import { Banknote, Check, CreditCard, Landmark, Wallet } from 'lucide-react';
import { cn } from '@/utils/Helpers';

// Icon + accent per method type, mirroring the cashier POS (pos-merchatai):
// clean line icons, never emoji. A selected row overrides everything to primary.
const TYPE_META: Record<
  AbonoMethodType,
  { Icon: typeof Banknote; color: string }
> = {
  cash: { Icon: Banknote, color: 'text-emerald-600 dark:text-emerald-400' },
  transfer: { Icon: Landmark, color: 'text-teal-600 dark:text-teal-400' },
  card: { Icon: CreditCard, color: 'text-sky-600 dark:text-sky-400' },
  other: { Icon: Wallet, color: 'text-muted-foreground' },
};

// Stacked selectable rows: icon · name (+ account subtitle) · check when active.
// A faithful port of pos-merchatai's CreditosCajero payment picker.
export function AbonoMethodPicker({
  methods,
  value,
  onChange,
  disabled,
}: {
  methods: AbonoMethod[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  if (methods.length === 0) {
    return (
      <div className="
        rounded-lg border border-dashed p-3 text-xs text-muted-foreground
      "
      >
        No hay métodos de pago configurados. Agregá uno en Ajustes → Métodos de
        pago.
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="Método de pago" className="space-y-2">
      {methods.map((m) => {
        const meta = TYPE_META[m.type];
        const active = m.value === value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(m.value)}
            className={cn(
              `
                flex w-full items-center gap-3 rounded-xl border px-4 py-2.5
                text-left transition-all
                disabled:cursor-not-allowed disabled:opacity-60
              `,
              active
                ? 'border-primary bg-primary/10 text-primary'
                : `
                  border-input bg-card text-foreground
                  hover:border-foreground/30
                `,
            )}
          >
            <meta.Icon
              className={cn(
                'size-[18px] shrink-0',
                active ? 'text-primary' : meta.color,
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {m.label}
              </span>
              {m.subtitle && (
                <span className="block truncate text-xs text-muted-foreground">
                  {m.subtitle}
                </span>
              )}
            </span>
            {active && <Check className="size-4 shrink-0 text-primary" />}
          </button>
        );
      })}
    </div>
  );
}
