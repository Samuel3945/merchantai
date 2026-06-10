'use client';

import type { BulkPriceMode } from './actions';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Bulk price-increase dialog. The owner picks a mode (percentage or flat amount)
// and a positive value applied to EACH selected product's current price. We
// can't preview an exact result because prices vary per product, so the hint
// describes the operation plainly instead of faking a single number.
export function BulkPriceDialog({
  count,
  pending,
  onApply,
  onClose,
}: {
  count: number;
  pending: boolean;
  onApply: (mode: BulkPriceMode, value: number) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<BulkPriceMode>('percent');
  const [value, setValue] = useState('');

  const num = Number.parseFloat(value);
  const valid
    = Number.isFinite(num) && num > 0 && (mode !== 'percent' || num <= 1000);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (valid) {
      onApply(mode, num);
    }
  }

  return (
    <div
      className="
        fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4
      "
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="
          w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg
        "
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Subir precio</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Se aplicará a
          {' '}
          <strong>{count}</strong>
          {' '}
          {count === 1 ? 'producto seleccionado' : 'productos seleccionados'}
          .
        </p>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['percent', 'Porcentaje (%)'],
              ['amount', 'Monto ($)'],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'h-10 rounded-md border text-sm font-medium transition-colors',
                  mode === m
                    ? 'border-primary bg-primary/10 text-primary'
                    : `
                      border-input text-muted-foreground
                      hover:bg-accent
                    `,
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="text-sm font-medium">
              {mode === 'percent' ? 'Aumento en %' : 'Aumento en $'}
            </label>
            <input
              autoFocus
              inputMode="decimal"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={mode === 'percent' ? '15' : '500'}
              className={cn(inputCls, 'mt-1')}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === 'percent'
                ? 'Cada producto sube ese porcentaje sobre su precio actual.'
                : 'Cada producto sube esa cantidad fija sobre su precio actual.'}
            </p>
          </div>

          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? 'Aplicando…' : 'Aplicar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
