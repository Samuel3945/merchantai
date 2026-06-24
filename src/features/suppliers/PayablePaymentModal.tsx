'use client';

import type { OpenPayable, RecordPayablePaymentResult } from './actions';
import type { PaymentContainer } from '@/actions/inventory';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ContainerSelector } from '@/features/inventory/components/ContainerSelector';
import { cn } from '@/utils/Helpers';
import { recordPayablePaymentAction } from './actions';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  return cop.format(Number.isFinite(n as number) ? (n as number) : 0);
}

type PaymentMode = 'full' | 'partial';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * Modal for paying an open/partial supplier payable from the "Compras por pagar"
 * view. Supports full and partial payments. Reuses ContainerSelector (Slice 2)
 * for container selection.
 *
 * Satisfies: REQ-6.3, REQ-6.4, SC-5.3, SC-5.4.
 */
export function PayablePaymentModal(props: {
  payable: OpenPayable;
  accounts: PaymentContainer[];
  onSuccess: () => void;
  onClose: () => void;
}) {
  const { payable, accounts, onSuccess, onClose } = props;

  const outstanding = Number.parseFloat(payable.outstanding);

  const [mode, setMode] = useState<PaymentMode>('full');
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');
  const [partialAmount, setPartialAmount] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resolveAmount(): number {
    if (mode === 'full') {
      return outstanding;
    }
    return Number.parseFloat(partialAmount) || 0;
  }

  function canSubmit(): boolean {
    if (!accountId) {
      return false;
    }
    if (mode === 'partial') {
      const amt = resolveAmount();
      return amt > 0 && amt < outstanding;
    }
    return outstanding > 0;
  }

  function handleSubmit() {
    const amount = resolveAmount();
    setError(null);

    startTransition(async () => {
      try {
        await recordPayablePaymentAction({
          payableId: payable.id,
          fromAccountId: accountId,
          amount,
          note: null,
        }) as RecordPayablePaymentResult;
        onSuccess();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Error inesperado al registrar el pago',
        );
      }
    });
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
          <DialogDescription>
            {payable.supplierName ?? 'Proveedor'}
            {payable.productName ? ` — ${payable.productName}` : ''}
          </DialogDescription>
        </DialogHeader>

        {/* Payable summary */}
        <div className="
          space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-sm
        "
        >
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total compra</span>
            <span className="font-medium tabular-nums">{money(payable.totalAmount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Ya pagado</span>
            <span className="tabular-nums">{money(payable.paidAmount)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-border pt-1">
            <span className="font-medium">Pendiente</span>
            <span className="font-semibold text-amber-600 tabular-nums">
              {money(payable.outstanding)}
            </span>
          </div>
        </div>

        {/* Payment mode toggle */}
        <div className="space-y-2">
          <p className="text-sm font-medium">¿Cuánto querés pagar?</p>
          <div className="flex gap-2">
            {(['full', 'partial'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={cn(
                  `
                    flex-1 rounded-md border px-3 py-2 text-sm font-medium
                    transition-colors
                  `,
                  mode === m
                    ? 'border-primary bg-primary text-primary-foreground'
                    : `
                      border-border bg-background text-foreground
                      hover:bg-muted
                    `,
                )}
              >
                {m === 'full' ? `Total (${money(payable.outstanding)})` : 'Parcial'}
              </button>
            ))}
          </div>

          {mode === 'partial' && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="partial-amount">
                Monto a pagar
              </label>
              <input
                id="partial-amount"
                type="number"
                min="1"
                step="1"
                max={outstanding - 0.01}
                value={partialAmount}
                onChange={(e) => {
                  setPartialAmount(e.target.value);
                  setError(null);
                }}
                placeholder={`Máx ${money(payable.outstanding)}`}
                className={inputCls}
              />
              {partialAmount !== '' && Number.parseFloat(partialAmount) >= outstanding && (
                <p className="text-xs text-destructive">
                  El monto parcial debe ser menor al pendiente (
                  {money(payable.outstanding)}
                  ).
                </p>
              )}
            </div>
          )}
        </div>

        {/* Container selector */}
        <div className="space-y-1">
          <p className="text-sm font-medium">Contenedor a debitar</p>
          {accounts.length === 0
            ? (
                <p className="text-sm text-destructive">
                  No hay contenedores activos. Creá una Caja, Caja fuerte o cuenta Banco primero.
                </p>
              )
            : (
                <ContainerSelector
                  accounts={accounts}
                  value={accountId}
                  onChange={(id) => {
                    setAccountId(id);
                    setError(null);
                  }}
                  disabled={pending}
                />
              )}
        </div>

        {/* Inline error */}
        {error && (
          <p className="
            rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2
            text-sm text-destructive
          "
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending || !canSubmit()}
          >
            {pending ? 'Registrando…' : 'Registrar pago'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
