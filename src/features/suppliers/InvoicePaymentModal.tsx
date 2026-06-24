'use client';

import type { OpenInvoiceGroup } from './actions';
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
import { recordInvoicePaymentAction } from './actions';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  return cop.format(Number.isFinite(n as number) ? (n as number) : 0);
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * Modal for paying a supplier invoice (all open lines) as a unit.
 *
 * Delegates to recordInvoicePaymentAction which calls recordInvoicePayment:
 *   - Allocates oldest-first across payable lines.
 *   - Single outer tx: all-or-nothing for the invoice.
 *   - Amount capped at SUM(line outstanding).
 *
 * Supports full and partial invoice payments.
 * Reuses ContainerSelector for container selection.
 */
export function InvoicePaymentModal(props: {
  invoice: OpenInvoiceGroup;
  accounts: PaymentContainer[];
  onSuccess: () => void;
  onClose: () => void;
}) {
  const { invoice, accounts, onSuccess, onClose } = props;

  const outstanding = Number.parseFloat(invoice.outstanding);

  const [mode, setMode] = useState<'full' | 'partial'>('full');
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
    if (!accountId || !invoice.purchaseId) {
      return false;
    }
    if (mode === 'partial') {
      const amt = resolveAmount();
      return amt > 0 && amt < outstanding;
    }
    return outstanding > 0;
  }

  function handleSubmit() {
    if (!invoice.purchaseId) {
      return;
    }
    const amount = resolveAmount();
    setError(null);

    startTransition(async () => {
      try {
        await recordInvoicePaymentAction({
          purchaseId: invoice.purchaseId!,
          fromAccountId: accountId,
          amount,
          note: null,
        });
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pagar factura</DialogTitle>
          <DialogDescription>
            {invoice.supplierName ?? 'Proveedor'}
            {invoice.invoiceNumber ? ` — ${invoice.invoiceNumber}` : ''}
            {' '}
            ·
            {' '}
            {invoice.lineCount}
            {' '}
            {invoice.lineCount === 1 ? 'línea' : 'líneas'}
          </DialogDescription>
        </DialogHeader>

        {/* Invoice summary */}
        <div className="
          space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-sm
        "
        >
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total factura</span>
            <span className="font-medium tabular-nums">{money(invoice.totalAmount)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-border pt-1">
            <span className="font-medium">Pendiente</span>
            <span className="font-semibold text-amber-600 tabular-nums">
              {money(invoice.outstanding)}
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
                className={`
                  flex-1 rounded-md border px-3 py-2 text-sm font-medium
                  transition-colors
                  ${mode === m
                ? 'border-primary bg-primary text-primary-foreground'
                : `
                  border-border bg-background text-foreground
                  hover:bg-muted
                `}
                `}
              >
                {m === 'full' ? `Total (${money(invoice.outstanding)})` : 'Parcial'}
              </button>
            ))}
          </div>

          {mode === 'partial' && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="invoice-partial-amount">
                Monto a pagar
              </label>
              <input
                id="invoice-partial-amount"
                type="number"
                min="1"
                step="1"
                max={outstanding - 0.01}
                value={partialAmount}
                onChange={(e) => {
                  setPartialAmount(e.target.value);
                  setError(null);
                }}
                placeholder={`Máx ${money(invoice.outstanding)}`}
                className={inputCls}
              />
              {partialAmount !== '' && Number.parseFloat(partialAmount) >= outstanding && (
                <p className="text-xs text-destructive">
                  El monto parcial debe ser menor al pendiente (
                  {money(invoice.outstanding)}
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
                  No hay contenedores activos.
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
          <Button onClick={handleSubmit} disabled={pending || !canSubmit()}>
            {pending ? 'Registrando…' : 'Registrar pago'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
