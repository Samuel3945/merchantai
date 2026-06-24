'use client';

import type { PaymentContainer, ProductLot } from '@/actions/inventory';
import { useEffect, useState, useTransition } from 'react';
import { listPaymentContainers } from '@/actions/inventory';
import { returnLot } from '@/actions/supplier-returns';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast-store';
import { ContainerSelector } from './ContainerSelector';

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('es-CO')}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Modal for returning units of a specific lot to its supplier.
 *
 * Computes the credit/refund split client-side (using the lot's outstanding)
 * so the user sees the breakdown before confirming. The server recomputes with
 * fresh locked values — if the split differs materially the action still succeeds
 * (e.g. a concurrent payment reduced outstanding between modal open and confirm).
 *
 * The container selector is shown ONLY when the computed refundPortion > 0.
 * If outstanding covers the full returnValue, no cash changes hands → no container needed.
 */
export function LotReturnModal({
  lot,
  onClose,
  onSuccess,
}: {
  lot: ProductLot;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState('1');
  const [containerId, setContainerId] = useState('');
  const [containers, setContainers] = useState<PaymentContainer[]>([]);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const unitCost = lot.unitCost != null ? Number(lot.unitCost) : 0;
  const outstanding = lot.outstanding != null ? Number(lot.outstanding) : 0;
  const qtyNum = Number.parseFloat(qty) || 0;

  // Derived split math (mirrors server-side computation, using client-side outstanding).
  const returnValue = round2(qtyNum * unitCost);
  const creditPortion = round2(Math.min(returnValue, outstanding));
  const refundPortion = round2(returnValue - creditPortion);

  const needsContainer = refundPortion > 0.005;

  const isQtyValid
    = qtyNum > 0
      && Number.isFinite(qtyNum)
      && qtyNum <= lot.remainingQty + 0.0005;

  const canSubmit
    = isQtyValid
      && (!needsContainer || containerId.length > 0)
      && !pending;

  // Load containers whenever the computed refundPortion becomes > 0.
  useEffect(() => {
    if (!needsContainer) {
      return;
    }
    let active = true;
    listPaymentContainers()
      .then((rows) => {
        if (active) {
          setContainerError(null);
          setContainers(rows);
        }
      })
      .catch(() => {
        if (active) {
          setContainerError('No se pudieron cargar los contenedores. Recargá la página.');
        }
      });
    return () => {
      active = false;
    };
  }, [needsContainer]);

  function handleSubmit() {
    if (!canSubmit) {
      return;
    }
    startTransition(async () => {
      try {
        await returnLot({
          lotId: lot.id,
          qtyReturned: qtyNum,
          refundContainerId: needsContainer ? containerId : null,
        });
        toast.success('Devolución registrada');
        onSuccess();
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error inesperado';
        if (msg.includes('qty_exceeds_remaining')) {
          toast.error('La cantidad supera las unidades disponibles en este lote');
        } else if (msg.includes('refund_container_required')) {
          toast.error('Seleccioná un contenedor para recibir el reembolso');
        } else {
          toast.error(msg);
        }
      }
    });
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Devolver al proveedor</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Qty input */}
          <div className="space-y-1">
            <label htmlFor="lot-return-qty" className="text-sm font-medium">
              Unidades a devolver
            </label>
            <input
              id="lot-return-qty"
              type="number"
              min={1}
              max={lot.remainingQty}
              step={1}
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="
                flex h-9 w-full rounded-md border border-input bg-transparent
                px-3 py-1 text-sm shadow-xs outline-none
                focus-visible:ring-2 focus-visible:ring-ring/50
              "
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Disponibles en este lote:
              {' '}
              {lot.remainingQty}
            </p>
          </div>

          {/* Split preview */}
          {isQtyValid && returnValue > 0.005 && (
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Desglose de la devolución</p>
              <div className="flex justify-between text-muted-foreground">
                <span>Valor de retorno</span>
                <span className="font-medium text-foreground">{money(returnValue)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Crédito (reduce deuda)</span>
                <span className={creditPortion > 0
                  ? `font-medium text-foreground`
                  : ''}
                >
                  {money(creditPortion)}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Reembolso en efectivo</span>
                <span className={refundPortion > 0
                  ? `font-medium text-foreground`
                  : ''}
                >
                  {money(refundPortion)}
                </span>
              </div>
              {refundPortion > 0.005 && (
                <p className="pt-1 text-xs text-amber-600">
                  El proveedor debe devolver
                  {' '}
                  {money(refundPortion)}
                  {' '}
                  en efectivo.
                </p>
              )}
            </div>
          )}

          {/* Container selector — only when refundPortion > 0 */}
          {needsContainer && (
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Contenedor donde entra el reembolso
              </label>
              <ContainerSelector
                accounts={containers}
                value={containerId}
                onChange={setContainerId}
                disabled={pending}
              />
              {containerError && (
                <p className="text-sm text-destructive">{containerError}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {pending ? 'Procesando…' : 'Confirmar devolución'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
