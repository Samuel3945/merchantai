'use client';

import type { WithdrawalDestino } from '@/actions/cash';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { cashInputCls } from './cash-ui';
import { DenominationCounter } from './DenominationCounter';

const labelCls = 'mb-1.5 block text-sm font-medium';
const chipCls
  = 'rounded-lg border px-3 py-2 text-sm font-medium transition-colors';

const DESTINOS: { value: WithdrawalDestino; label: string }[] = [
  { value: 'caja_fuerte', label: 'Caja fuerte' },
  { value: 'banco', label: 'Banco' },
  { value: 'oficina', label: 'Oficina' },
  { value: 'otro', label: 'Otro' },
];

/**
 * Simplified one-step security withdrawal. Monto + destino, nothing else — the
 * whole point is that the owner moves cash to safety without friction.
 */
export function RetiroRapidoModal(props: {
  pending: boolean;
  error: string | null;
  suggestedAmount?: number;
  onClose: () => void;
  onSubmit: (amount: string, destino: WithdrawalDestino) => void;
}) {
  const [amount, setAmount] = useState(
    props.suggestedAmount && props.suggestedAmount > 0
      ? String(Math.round(props.suggestedAmount))
      : '',
  );
  const [destino, setDestino] = useState<WithdrawalDestino>('caja_fuerte');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        props.onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const amountNum = Number.parseFloat(amount);
  const canSubmit = Number.isFinite(amountNum) && amountNum > 0;

  return (
    <div
      className="
        fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0
        sm:items-center sm:p-4
      "
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
    >
      <div
        className="
          w-full max-w-md rounded-t-2xl border bg-background p-5 shadow-lg
          sm:rounded-2xl
        "
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className="
              flex size-7 items-center justify-center rounded-full bg-warn/10
              text-sm
            "
            >
              💰
            </span>
            Retiro rápido
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="
              text-muted-foreground
              hover:text-foreground
            "
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="retiro-amount">
              Monto
            </label>
            <input
              id="retiro-amount"
              className={cashInputCls}
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="0"
              autoFocus
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <DenominationCounter
              className="mt-2"
              onTotal={t => setAmount(t > 0 ? String(t) : '')}
            />
          </div>

          <div>
            <div className={labelCls}>Destino</div>
            <div className="grid grid-cols-2 gap-2">
              {DESTINOS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDestino(opt.value)}
                  className={cn(
                    chipCls,
                    destino === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : `
                        border-border text-muted-foreground
                        hover:border-input
                      `,
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {props.error && (
            <div className="
              rounded-lg border border-destructive/30 bg-destructive/10 px-3
              py-2 text-sm text-destructive
            "
            >
              {props.error}
            </div>
          )}

          <Button
            className="w-full"
            size="lg"
            disabled={props.pending || !canSubmit}
            onClick={() => props.onSubmit(amount, destino)}
          >
            Registrar retiro
          </Button>
        </div>
      </div>
    </div>
  );
}
