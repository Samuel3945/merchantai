'use client';

import type { Direction, EntryMotivo, ExitMotivo } from './cash-ui';
import type { Supplier, SupplierOption } from '@/features/suppliers/actions';
import type { CashMovementType } from '@/libs/cash-helpers';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listSuppliersForSelect } from '@/features/suppliers/actions';
import { SupplierModal } from '@/features/suppliers/SupplierModal';
import { SupplierSelect } from '@/features/suppliers/SupplierSelect';
import { cn } from '@/utils/Helpers';
import {
  cashInputCls,
  ENTRY_MOTIVOS,
  entryTypeFor,
  EXIT_MOTIVOS,
  exitTypeFor,
} from './cash-ui';
import { DenominationCounter } from './DenominationCounter';

export type MovementSubmit = {
  type: CashMovementType;
  amount: string;
  reason: string;
  category: string | null;
  supplierId: string | null;
};

const labelCls = 'mb-1.5 block text-sm font-medium';
const chipCls
  = 'rounded-lg border px-3 py-2 text-sm font-medium transition-colors';

/**
 * Quick-action modal for registering a single cash movement. Deliberately
 * minimal: monto + motivo, plus a category when paying an expense and a
 * mandatory description when the motivo is "Otro". The motivo → DB type mapping
 * lives in cash-ui so this component stays presentational.
 */
export function MovementModal(props: {
  direction: Direction;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: MovementSubmit) => void;
}) {
  const { direction, onClose } = props;
  const isIn = direction === 'in';
  const motivos = isIn ? ENTRY_MOTIVOS : EXIT_MOTIVOS;

  const [motivo, setMotivo] = useState<string>(motivos[0]!.value);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [supplier, setSupplier] = useState<SupplierOption | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [showSupplierModal, setShowSupplierModal] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isOtro = motivo === 'otro';
  const isRetiro = !isIn && motivo === 'retiro_seguridad';
  const isProveedor = !isIn && motivo === 'pago_proveedor';

  // Lazily load the supplier list the first time the user picks "Pago a
  // proveedor" — no point fetching it for every cash movement.
  useEffect(() => {
    if (!isProveedor || supplierOptions.length > 0 || supplierLoading) {
      return;
    }
    setSupplierLoading(true);
    listSuppliersForSelect()
      .then(setSupplierOptions)
      .finally(() => setSupplierLoading(false));
  }, [isProveedor, supplierOptions.length, supplierLoading]);

  const amountNum = Number.parseFloat(amount);
  const canSubmit
    = Number.isFinite(amountNum)
      && amountNum > 0
      && (!isOtro || description.trim().length > 0)
      && (!isProveedor || supplier !== null);

  function onSupplierCreated(s: Supplier) {
    const opt: SupplierOption = { id: s.id, name: s.name, company: s.company };
    setSupplierOptions(prev => [opt, ...prev.filter(o => o.id !== opt.id)]);
    setSupplier(opt);
    setShowSupplierModal(false);
  }

  function submit() {
    if (!canSubmit) {
      return;
    }

    const motivoLabel = motivos.find(o => o.value === motivo)?.label ?? '';
    const note = description.trim();

    let type: CashMovementType;
    let reason: string;
    let supplierId: string | null = null;

    if (isIn) {
      type = entryTypeFor(motivo as EntryMotivo);
      reason = isOtro ? note : note ? `${motivoLabel} — ${note}` : motivoLabel;
    } else {
      const m = motivo as ExitMotivo;
      type = exitTypeFor(m);
      if (m === 'pago_proveedor') {
        supplierId = supplier?.id ?? null;
        const base = supplier?.name
          ? `Pago a ${supplier.name}`
          : 'Pago a proveedor';
        reason = note ? `${base} — ${note}` : base;
      } else if (isOtro) {
        reason = note;
      } else {
        reason = note ? `${motivoLabel} — ${note}` : motivoLabel;
      }
    }

    props.onSubmit({ type, amount, reason, category: null, supplierId });
  }

  return (
    <>
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
              <span
                className={cn(
                  'flex size-7 items-center justify-center rounded-full text-sm',
                  isIn
                    ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                {isIn ? '↑' : '↓'}
              </span>
              {isIn ? 'Registrar entrada' : 'Registrar salida'}
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
              <label className={labelCls} htmlFor="mov-amount">
                Monto
              </label>
              <input
                id="mov-amount"
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
              <div className={labelCls}>Motivo</div>
              <div className="grid grid-cols-2 gap-2">
                {motivos.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setMotivo(opt.value)}
                    className={cn(
                      chipCls,
                      motivo === opt.value
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

            {isProveedor && (
              <div>
                <label className={labelCls}>Proveedor *</label>
                <SupplierSelect
                  options={supplierOptions}
                  value={supplier}
                  loading={supplierLoading}
                  onChange={setSupplier}
                  onQuickCreate={() => setShowSupplierModal(true)}
                />
              </div>
            )}

            <div>
              <label className={labelCls} htmlFor="mov-description">
                {isOtro
                  ? 'Descripción'
                  : isRetiro
                    ? 'Destino (opcional)'
                    : 'Nota (opcional)'}
              </label>
              <input
                id="mov-description"
                className={cashInputCls}
                placeholder={
                  isRetiro ? 'Caja fuerte, banco, oficina…' : 'Describe el motivo'
                }
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
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
              onClick={submit}
            >
              {isIn ? 'Registrar entrada' : 'Registrar salida'}
            </Button>
          </div>
        </div>
      </div>

      {showSupplierModal && (
        <SupplierModal
          editing={null}
          onClose={() => setShowSupplierModal(false)}
          onSaved={onSupplierCreated}
        />
      )}
    </>
  );
}
