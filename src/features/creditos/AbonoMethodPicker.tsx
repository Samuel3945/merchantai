'use client';

import type { AbonoMethod, AbonoMethodType } from '@/libs/creditos-shared';
import { cn } from '@/utils/Helpers';

// Per-type visual theme, mirroring the cashier POS (pos-merchatai methodTheme):
// cash=green, transfer=teal/primary, card=blue, other=neutral. Selected classes
// are spelled out in full so Tailwind's JIT keeps them (never build class names
// by string interpolation).
const THEME: Record<
  AbonoMethodType,
  { selected: string; icon: string }
> = {
  cash: {
    selected:
      'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/40 text-emerald-700 dark:text-emerald-300',
    icon: '💵',
  },
  transfer: {
    selected: 'border-primary bg-primary/10 ring-2 ring-primary/40 text-primary',
    icon: '🏦',
  },
  card: {
    selected:
      'border-sky-500 bg-sky-500/10 ring-2 ring-sky-500/40 text-sky-700 dark:text-sky-300',
    icon: '💳',
  },
  other: {
    selected: 'border-foreground/40 bg-muted ring-2 ring-foreground/20 text-foreground',
    icon: '💰',
  },
};

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
    <div
      role="radiogroup"
      aria-label="Método de pago"
      className="
        grid grid-cols-2 gap-2
        sm:grid-cols-3
      "
    >
      {methods.map((m) => {
        const theme = THEME[m.type];
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
                flex h-16 flex-col items-center justify-center gap-0.5
                rounded-lg border px-2 text-center transition
                hover:border-foreground/30
                disabled:cursor-not-allowed disabled:opacity-60
              `,
              active ? theme.selected : 'border-input bg-card text-foreground',
            )}
          >
            <span className="text-lg leading-none" aria-hidden>
              {m.icon || theme.icon}
            </span>
            <span className="line-clamp-1 text-xs font-medium">{m.label}</span>
            {m.subtitle && (
              <span className="line-clamp-1 text-[10px] text-muted-foreground">
                {m.subtitle}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
