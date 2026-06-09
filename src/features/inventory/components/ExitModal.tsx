'use client';

import type { InventoryProduct, MovementReason, ProductLot } from '@/actions/inventory';
import { useEffect, useState, useTransition } from 'react';
import { getProductLots, recordMovement } from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import {
  EXIT_REASON_OPTIONS,
  exitFormSchema,
  reasonRequiresNotes,
} from '../validation';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-sm font-medium';

function isExpired(lot: ProductLot): boolean {
  return !!lot.expiresAt && new Date(lot.expiresAt) <= new Date();
}

export function ExitModal({
  product,
  onClose,
  onSuccess,
}: {
  product: InventoryProduct;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<MovementReason>('damaged');
  const [notes, setNotes] = useState('');
  const [lots, setLots] = useState<ProductLot[]>([]);
  const [pending, startTransition] = useTransition();

  const needsNotes = reasonRequiresNotes(reason);
  const showLots = reason === 'expired' && product.isPerishable;
  const canConfirm
    = Number(qty) > 0 && (!needsNotes || notes.trim().length > 0);

  // Load the FIFO ledger lots the first time the user picks "Se venció" so we
  // can surface (and preselect) the expiring batches the exit will consume.
  useEffect(() => {
    if (!showLots || lots.length > 0) {
      return;
    }
    let active = true;
    getProductLots(product.id)
      .then((rows) => {
        if (active) {
          setLots(rows.filter(l => l.expiresAt));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showLots, product.id, lots.length]);

  function fillFromExpiredLots() {
    const expired = lots.filter(isExpired);
    const source = expired.length > 0 ? expired : lots.slice(0, 1);
    const total = source.reduce((s, l) => s + l.remainingQty, 0);
    if (total > 0) {
      setQty(String(total));
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = exitFormSchema.safeParse({ qty, reason, notes });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Revisá los datos');
      return;
    }
    startTransition(async () => {
      try {
        await recordMovement({
          productId: product.id,
          type: 'exit',
          qty: parsed.data.qty,
          reason: parsed.data.reason,
          notes: parsed.data.notes,
        });
        toast.success(`Salida registrada para "${product.name}"`);
        onSuccess();
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  const dateFmt = new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Salida / Pérdida —
            {' '}
            {product.name}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className={labelCls}>Motivo</label>
            <Select
              value={reason}
              onValueChange={v => setReason(v as MovementReason)}
              options={EXIT_REASON_OPTIONS.map(o => ({
                value: o.value,
                label: o.label,
              }))}
            />
          </div>

          {showLots && (
            <div className="
              space-y-2 rounded-md border border-terracotta/40 bg-terracotta/5
              p-3
            "
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-terracotta">
                  Lotes por vencer (orden FIFO)
                </span>
                {lots.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={fillFromExpiredLots}
                  >
                    Usar lotes vencidos
                  </Button>
                )}
              </div>
              {lots.length === 0
                ? (
                    <p className="text-xs text-muted-foreground">
                      Sin lotes con fecha de caducidad registrada.
                    </p>
                  )
                : (
                    <ul className="space-y-1 text-xs">
                      {lots.map(l => (
                        <li
                          key={l.id}
                          className={cn(
                            'flex justify-between',
                            isExpired(l) && 'font-medium text-destructive',
                          )}
                        >
                          <span>
                            {l.remainingQty}
                            {' '}
                            u · vence
                            {' '}
                            {l.expiresAt ? dateFmt.format(new Date(l.expiresAt)) : '—'}
                            {isExpired(l) ? ' (vencido)' : ''}
                          </span>
                          <span className="font-mono text-muted-foreground">
                            $
                            {l.unitCost ?? '—'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              <p className="text-xs text-muted-foreground">
                La salida consume primero el lote más viejo (FIFO).
              </p>
            </div>
          )}

          <div>
            <label className={labelCls}>
              Cantidad
              {' '}
              <span className="text-destructive">*</span>
            </label>
            <input
              required
              type="number"
              min="1"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className={inputCls}
              autoFocus
            />
          </div>

          {needsNotes && (
            <div>
              <label className={labelCls}>
                Describí el motivo
                {' '}
                <span className="text-destructive">*</span>
              </label>
              <input
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className={inputCls}
                placeholder="Ej. faltante de conteo"
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || !canConfirm}>
              {pending ? 'Guardando...' : 'Registrar salida'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
