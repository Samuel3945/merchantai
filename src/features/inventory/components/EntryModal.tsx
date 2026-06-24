'use client';

import type { InventoryProduct, MovementReason, PaymentContainer } from '@/actions/inventory';
import { useEffect, useState, useTransition } from 'react';
import { listPaymentContainers, recordMovement } from '@/actions/inventory';
import { DatePicker } from '@/components/DatePicker';
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
import {
  ENTRY_REASON_OPTIONS,
  entryFormSchema,
  reasonRequiresNotes,
} from '../validation';
import { ContainerSelector } from './ContainerSelector';
import { SupplierSelect } from './SupplierSelect';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-sm font-medium';

type PaymentStatus = 'unpaid' | 'full' | 'partial';

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

  // Pay-at-entry state — only active when reason === 'purchase'.
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('unpaid');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [containers, setContainers] = useState<PaymentContainer[]>([]);

  const [pending, startTransition] = useTransition();

  const needsNotes = reasonRequiresNotes(reason);
  const needsSupplier = reason === 'purchase';
  const needsExpiry = product.isPerishable;
  const needsPayment = reason === 'purchase';
  const needsContainer = needsPayment && (paymentStatus === 'full' || paymentStatus === 'partial');
  const needsPartialAmount = needsPayment && paymentStatus === 'partial';

  // Load payment containers when the user selects "purchase" as the reason.
  useEffect(() => {
    if (reason !== 'purchase') {
      return;
    }
    let active = true;
    listPaymentContainers()
      .then((rows) => {
        if (active) {
          setContainers(rows);
        }
      })
      .catch(() => {
        // non-fatal: ContainerSelector stays empty; user can proceed without paying
      });
    return () => {
      active = false;
    };
  }, [reason]);

  // When the reason changes away from purchase, reset payment state.
  function handleReasonChange(v: MovementReason) {
    setReason(v);
    if (v !== 'purchase') {
      setPaymentStatus('unpaid');
      setPaymentAccountId('');
      setPaymentAmount('');
    }
  }

  const totalCost = Number(qty) * Number(unitCost);

  // Every visible field must be valid before confirm is enabled.
  const canConfirm
    = Number(qty) > 0
      && Number(unitCost) > 0
      && (!needsSupplier || supplierId.trim().length > 0)
      && (!needsExpiry || expiresAt.trim().length > 0)
      && (!needsNotes || notes.trim().length > 0)
      && (!needsContainer || paymentAccountId.trim().length > 0)
      && (!needsPartialAmount || (Number(paymentAmount) > 0 && Number(paymentAmount) <= totalCost));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = entryFormSchema.safeParse({
      qty,
      unitCost,
      supplierId,
      expiresAt,
      reason,
      notes,
      paymentStatus,
      paymentAmount: paymentStatus === 'partial' ? paymentAmount : undefined,
      paymentAccountId: needsContainer ? paymentAccountId : undefined,
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
          paymentStatus: parsed.data.paymentStatus,
          paymentAmount: parsed.data.paymentAmount,
          paymentAccountId: parsed.data.paymentAccountId,
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
          <div>
            <label className={labelCls}>Motivo</label>
            <Select
              value={reason}
              onValueChange={v => handleReasonChange(v as MovementReason)}
              options={ENTRY_REASON_OPTIONS.map(o => ({
                value: o.value,
                label: o.label,
              }))}
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
                placeholder="Ej. inventario inicial, sobrante de conteo"
              />
            </div>
          )}
          <div>
            <label className={labelCls}>
              Costo unitario
              {' '}
              <span className="text-destructive">*</span>
            </label>
            <input
              required
              type="number"
              step="0.01"
              min="0"
              value={unitCost}
              onChange={e => setUnitCost(e.target.value)}
              className={inputCls}
            />
          </div>
          {needsSupplier && (
            <div>
              <label className={labelCls}>
                Proveedor
                {' '}
                <span className="text-destructive">*</span>
              </label>
              <SupplierSelect value={supplierId} onChange={setSupplierId} />
            </div>
          )}
          {needsExpiry && (
            <div>
              <label className={labelCls}>
                Fecha de caducidad
                {' '}
                <span className="text-destructive">*</span>
              </label>
              <DatePicker
                value={expiresAt}
                min={new Date().toISOString().slice(0, 10)}
                placeholder="¿Cuándo se vence este lote?"
                onChange={setExpiresAt}
                triggerClassName="w-full"
              />
            </div>
          )}

          {/* ── ¿Ya se pagó? — pay-at-entry (REQ-3.1, SC-2.x) ────────────── */}
          {needsPayment && (
            <>
              <div>
                <label className={labelCls}>¿Ya se pagó?</label>
                <Select
                  value={paymentStatus}
                  onValueChange={v => setPaymentStatus(v as PaymentStatus)}
                  options={[
                    { value: 'unpaid', label: 'No, queda pendiente' },
                    { value: 'full', label: 'Sí, pagué el total' },
                    { value: 'partial', label: 'Sí, pagué una parte' },
                  ]}
                />
              </div>
              {needsContainer && (
                <div>
                  <label className={labelCls}>
                    ¿De dónde sale el dinero?
                    {' '}
                    <span className="text-destructive">*</span>
                  </label>
                  <ContainerSelector
                    accounts={containers}
                    value={paymentAccountId}
                    onChange={setPaymentAccountId}
                  />
                </div>
              )}
              {needsPartialAmount && (
                <div>
                  <label className={labelCls}>
                    Monto que pagás ahora
                    {' '}
                    <span className="text-destructive">*</span>
                  </label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={totalCost > 0 ? totalCost : undefined}
                    value={paymentAmount}
                    onChange={e => setPaymentAmount(e.target.value)}
                    className={inputCls}
                    placeholder={totalCost > 0 ? `Máximo ${totalCost.toFixed(2)}` : ''}
                  />
                </div>
              )}
            </>
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
