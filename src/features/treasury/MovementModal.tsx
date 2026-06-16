'use client';

import type { Direction, EntryMotivo, ExitMotivo } from '@/features/cash/cash-ui';
import type { Supplier, SupplierOption } from '@/features/suppliers/actions';
import type { CashMovementType } from '@/libs/cash-helpers';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  cashInputCls,
  ENTRY_MOTIVOS,
  entryTypeFor,
  EXIT_MOTIVOS,
  exitTypeFor,
  REASON_PRESETS,
} from '@/features/cash/cash-ui';
import { listSuppliersForSelect } from '@/features/suppliers/actions';
import { SupplierModal } from '@/features/suppliers/SupplierModal';
import { SupplierSelect } from '@/features/suppliers/SupplierSelect';
import { cn } from '@/utils/Helpers';

export type MovementSubmit = {
  type: CashMovementType;
  amount: string;
  reason: string;
  category: string | null;
  supplierId: string | null;
  // 2C: optional container for dual-write to treasury_movements.
  // toAccountId = cash entering a container (security withdrawal to vault).
  // fromAccountId = cash leaving a container (salida from container).
  toAccountId: string | null;
  fromAccountId: string | null;
};

const labelCls = 'mb-1.5 block text-sm font-medium';
const chipCls
  = 'rounded-lg border px-3 py-2 text-sm font-medium transition-colors';

/**
 * Quick-action modal for registering a single cash movement. Adopts the POS
 * cashier flow: ONE modal with an internal entrada/salida toggle plus reason
 * preset chips, while keeping the dashboard's extra power — supplier link for
 * "Pago a proveedor", the treasury container dual-write, and the `advance`
 * (vale empleado) type. The motivo → DB type mapping lives in cash-ui so this
 * component stays presentational.
 *
 * `initialDirection` only seeds the toggle — the user can flip direction without
 * reopening the modal.
 *
 * 2C: accepts an optional `treasuryAccounts` list. When provided:
 *   - For retiro_seguridad (salida): shows a container selector so the owner
 *     can pick which vault/container receives the dual-write entrada.
 *   - For entradas (in): shows a container selector for the optional fromAccountId.
 *   - Single account: auto-selected, no selector rendered (no friction).
 *   - No accounts: selector hidden entirely (backward compatible).
 */
export function MovementModal(props: {
  initialDirection: Direction;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: MovementSubmit) => void;
  treasuryAccounts?: TreasuryAccountRow[];
}) {
  const { onClose } = props;
  const [dir, setDir] = useState<Direction>(props.initialDirection);
  const isIn = dir === 'in';
  const motivos = isIn ? ENTRY_MOTIVOS : EXIT_MOTIVOS;

  const [motivo, setMotivo] = useState<string>(motivos[0]!.value);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [supplier, setSupplier] = useState<SupplierOption | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [showSupplierModal, setShowSupplierModal] = useState(false);

  // 2C: container selector state.
  const accounts = props.treasuryAccounts ?? [];

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
  const reasonPresets = REASON_PRESETS[motivo as EntryMotivo | ExitMotivo] ?? [];

  // Flip entrada ↔ salida in-place (POS pattern). Reset the motivo-scoped fields
  // so a stale supplier/description never leaks across directions.
  function switchDir(next: Direction) {
    if (next === dir) {
      return;
    }
    setDir(next);
    const nextMotivos = next === 'in' ? ENTRY_MOTIVOS : EXIT_MOTIVOS;
    setMotivo(nextMotivos[0]!.value);
    setDescription('');
    setSupplier(null);
  }

  // 2C: container selector — visible for retiro_seguridad (vault entry) or any entrada.
  // Single account → auto-select, no selector shown. No accounts → hidden entirely.
  const showContainerSelector = (isRetiro || isIn) && accounts.length > 0;
  const autoSelectedAccount = accounts.length === 1 ? accounts[0] : null;
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    autoSelectedAccount?.id ?? null,
  );

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

    // 2C: resolve container ids for the optional treasury dual-write.
    // retiro_seguridad (out): cash enters the selected vault → toAccountId.
    // entrada (in): cash comes from outside a container → fromAccountId.
    // Only set when showContainerSelector and an account is selected/auto-selected.
    let toAccountId: string | null = null;
    let fromAccountId: string | null = null;
    if (showContainerSelector && selectedAccountId) {
      if (isRetiro) {
        toAccountId = selectedAccountId;
      } else if (isIn) {
        fromAccountId = selectedAccountId;
      }
    }

    props.onSubmit({ type, amount, reason, category: null, supplierId, toAccountId, fromAccountId });
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
              Movimiento de caja
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
            {/* Toggle dirección — una sola modal para entrada y salida, como el POS. */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => switchDir('out')}
                className={cn(
                  `
                    h-10 rounded-lg border text-sm font-semibold
                    transition-colors
                  `,
                  !isIn
                    ? 'border-destructive bg-destructive/10 text-destructive'
                    : `
                      border-border text-muted-foreground
                      hover:border-input
                    `,
                )}
              >
                ↓ Sale dinero
              </button>
              <button
                type="button"
                onClick={() => switchDir('in')}
                className={cn(
                  `
                    h-10 rounded-lg border text-sm font-semibold
                    transition-colors
                  `,
                  isIn
                    ? 'border-success bg-success/10 text-success'
                    : `
                      border-border text-muted-foreground
                      hover:border-input
                    `,
                )}
              >
                ↑ Entra dinero
              </button>
            </div>

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
                {isOtro ? 'Descripción' : 'Nota (opcional)'}
              </label>
              {reasonPresets.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {reasonPresets.map(preset => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setDescription(preset)}
                      className={cn(
                        `
                          rounded-lg border px-2.5 py-1 text-xs font-medium
                          transition-colors
                        `,
                        description === preset
                          ? 'border-primary bg-primary/10 text-primary'
                          : `
                            border-border text-muted-foreground
                            hover:border-input
                          `,
                      )}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              )}
              <input
                id="mov-description"
                className={cashInputCls}
                placeholder="Describe el motivo"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>

            {/* 2C: container selector for retiro_seguridad and entradas. */}
            {showContainerSelector && accounts.length > 1 && (
              <div>
                <label className={labelCls} htmlFor="mov-container">
                  {isRetiro ? 'Destino (contenedor)' : 'Fuente (contenedor)'}
                </label>
                <select
                  id="mov-container"
                  className={cashInputCls}
                  value={selectedAccountId ?? ''}
                  onChange={e => setSelectedAccountId(e.target.value || null)}
                >
                  <option value="">Sin contenedor</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

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
