'use client';

import type { InventoryProduct, MovementReason } from '@/actions/inventory';
import { useState, useTransition } from 'react';
import { recordMovement } from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import {
  ENTRY_REASON_OPTIONS,
  entryFormSchema,
  reasonRequiresNotes,
} from '../validation';
import { SupplierSelect } from './SupplierSelect';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-sm font-medium';

export function EntryModal({
  product,
  onClose,
  onSuccess,
}: {
  product: InventoryProduct;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState<MovementReason>('purchase');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();

  const needsNotes = reasonRequiresNotes(reason);
  const canConfirm
    = Number(qty) > 0 && (!needsNotes || notes.trim().length > 0);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = entryFormSchema.safeParse({
      qty,
      unitCost,
      supplierId,
      expiresAt,
      reason,
      notes,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Revisá los datos');
      return;
    }
    startTransition(async () => {
      try {
        await recordMovement({
          productId: product.id,
          type: 'entry',
          qty: parsed.data.qty,
          reason: parsed.data.reason,
          unitCost: parsed.data.unitCost,
          supplierId: parsed.data.supplierId,
          expiresAt: parsed.data.expiresAt,
          notes: parsed.data.notes,
        });
        toast.success(`Entrada registrada para "${product.name}"`);
        onSuccess();
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Entrada de stock —
            {' '}
            {product.name}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className={labelCls}>Cantidad</label>
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
          <div>
            <label className={labelCls}>Motivo</label>
            <select
              value={reason}
              onChange={e => setReason(e.target.value as MovementReason)}
              className={inputCls}
            >
              {ENTRY_REASON_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
                placeholder="Ej. inventario inicial, sobrante de conteo"
              />
            </div>
          )}
          <div>
            <label className={labelCls}>Costo unitario</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={unitCost}
              onChange={e => setUnitCost(e.target.value)}
              className={inputCls}
              placeholder="Opcional"
            />
          </div>
          {reason === 'purchase' && (
            <div>
              <label className={labelCls}>Proveedor</label>
              <SupplierSelect value={supplierId} onChange={setSupplierId} />
            </div>
          )}
          {product.isPerishable && (
            <div>
              <label className={labelCls}>Fecha de caducidad</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className={cn(inputCls)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !canConfirm}>
              {pending ? 'Guardando...' : 'Registrar entrada'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
