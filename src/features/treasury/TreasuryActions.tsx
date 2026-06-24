'use client';

import type { SupplierInvoiceRow, SupplierOutstandingRow } from '@/actions/treasury';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { ArrowRightLeft, Building2, Plus, Tag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { getSupplierInvoicesAction, listSuppliersWithOutstanding, recordGasto, recordSupplierPaymentFromConsole } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import {
  TREASURY_EXPENSE_CATEGORIES,
  TREASURY_EXPENSE_CATEGORY_LABELS,
} from './expenseCategories';
import { validateGasto } from './gastoValidation';

// ── Registrar gasto modal ─────────────────────────────────────────────────────

function GastoModal({
  accountRows,
  open,
  onClose,
}: {
  accountRows: TreasuryAccountRow[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fromAccountId, setFromAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [incurredOn, setIncurredOn] = useState(today);
  const [error, setError] = useState<string | null>(null);

  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );
  const hasEligible = eligible.length > 0;
  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  const categoryOptions = TREASURY_EXPENSE_CATEGORIES.map(cat => ({
    value: cat,
    label: TREASURY_EXPENSE_CATEGORY_LABELS[cat],
  }));

  function submit() {
    setError(null);
    const validationError = validateGasto({
      fromAccountId,
      amount,
      category,
      description: description || undefined,
      incurredOn,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    startTransition(async () => {
      try {
        const res = await recordGasto({
          fromAccountId,
          amount,
          category: category.trim(),
          description: description.trim() || null,
          incurredOn,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onClose();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Intentá de nuevo.');
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
        }
      }}
    >
      <DialogContent className="
        flex max-h-[90dvh] max-w-[460px] flex-col gap-0 overflow-hidden p-0
      "
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border px-[22px] py-5">
          <span className="
            text-[11px] font-semibold tracking-widest text-primary uppercase
          "
          >
            Registrar gasto
          </span>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Una salida de plata desde una caja fuerte o cuenta bancaria.
          </p>
        </div>

        {/* Body — scrolls when content exceeds the viewport so the footer stays reachable */}
        <div className="
          scrollbar-subtle min-h-0 flex-1 space-y-3 overflow-y-auto p-[22px]
        "
        >
          {hasEligible
            ? (
                <>
                  <Select
                    value={fromAccountId}
                    onValueChange={setFromAccountId}
                    options={fromOptions}
                    placeholder="Desde (contenedor de origen)"
                  />
                  <Select
                    value={category}
                    onValueChange={setCategory}
                    options={categoryOptions}
                    placeholder="Categoría del gasto"
                  />
                  <input
                    className={cashInputCls}
                    placeholder={
                      category === 'otros'
                        ? 'Motivo del gasto (requerido para Otros)'
                        : 'Descripción (opcional)'
                    }
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                  />
                  <input
                    className={cashInputCls}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    placeholder="Monto"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">
                      Fecha del gasto
                    </label>
                    <input
                      className={cashInputCls}
                      type="date"
                      value={incurredOn}
                      max={today}
                      onChange={e => setIncurredOn(e.target.value)}
                    />
                  </div>
                  {error && (
                    <div className="text-xs text-destructive">{error}</div>
                  )}
                </>
              )
            : (
                <p className="text-xs text-muted-foreground">
                  Necesitás al menos una caja fuerte o cuenta bancaria para
                  registrar gastos.
                </p>
              )}
        </div>

        {/* Footer — pinned below the scrollable body, always visible */}
        <div className="
          flex shrink-0 gap-2.5 border-t border-border bg-background px-[22px]
          pt-4 pb-[22px]
        "
        >
          <Button
            variant="outline"
            className="h-11 px-[18px]"
            disabled={isPending}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            className="h-11 flex-1"
            disabled={
              isPending
              || !hasEligible
              || !fromAccountId
              || !amount
              || !category
              || (category === 'otros' && !description.trim())
            }
            onClick={submit}
          >
            Registrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Pagar proveedor modal ─────────────────────────────────────────────────────

function SupplierPaymentModal({
  accountRows,
  open,
  onClose,
}: {
  accountRows: TreasuryAccountRow[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [suppliers, setSuppliers] = useState<SupplierOutstandingRow[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [fromAccountId, setFromAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<SupplierInvoiceRow[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  // Fetch per-invoice breakdown whenever the selected supplier changes.
  // The `active` flag guards against stale responses when the supplier changes quickly.
  useEffect(() => {
    if (!supplierId) {
      return;
    }
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) {
        return;
      }
      setLoadingInvoices(true);
      setInvoices([]);
      const res = await getSupplierInvoicesAction(supplierId);
      if (!active) {
        return;
      }
      if (res.ok) {
        setInvoices(res.data);
      }
      setLoadingInvoices(false);
    });
    return () => {
      active = false;
    };
  }, [supplierId]);

  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );
  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  // Load suppliers with outstanding when the modal opens.
  function handleOpen(isOpen: boolean) {
    if (isOpen && suppliers.length === 0 && !loadingSuppliers) {
      setLoadingSuppliers(true);
      listSuppliersWithOutstanding().then((res) => {
        if (res.ok) {
          setSuppliers(res.data);
        }
        setLoadingSuppliers(false);
      });
    }
    if (!isOpen) {
      setSupplierId('');
      setInvoices([]);
      setLoadingInvoices(false);
      onClose();
    }
  }

  const supplierOptions = suppliers.map(s => ({
    value: s.supplierId,
    label: `${s.name} — $${s.totalOutstanding.toLocaleString('es-CO')} pendiente`,
  }));

  const selectedSupplier = suppliers.find(s => s.supplierId === supplierId);

  function submit() {
    setError(null);
    if (!supplierId) {
      setError('Seleccioná un proveedor');
      return;
    }
    if (!fromAccountId) {
      setError('Seleccioná el contenedor de origen');
      return;
    }
    const amt = Number.parseFloat(amount);
    if (!amount || Number.isNaN(amt) || amt <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }
    startTransition(async () => {
      try {
        const res = await recordSupplierPaymentFromConsole({
          supplierId,
          fromAccountId,
          amount: amt,
          note: note.trim() || null,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Reset and close.
        setSupplierId('');
        setFromAccountId('');
        setAmount('');
        setNote('');
        setInvoices([]);
        setSuppliers([]); // force reload next open
        onClose();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Intentá de nuevo.');
      }
    });
  }

  const hasEligible = eligible.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="
        flex max-h-[90dvh] max-w-[460px] flex-col gap-0 overflow-hidden p-0
      "
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border px-[22px] py-5">
          <span className="
            text-[11px] font-semibold tracking-widest text-primary uppercase
          "
          >
            Pagar proveedor
          </span>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Salda una deuda pendiente con un proveedor desde una caja fuerte o cuenta bancaria.
          </p>
        </div>

        {/* Body */}
        <div className="
          scrollbar-subtle min-h-0 flex-1 space-y-3 overflow-y-auto p-[22px]
        "
        >
          {!hasEligible
            ? (
                <p className="text-xs text-muted-foreground">
                  Necesitás al menos una caja fuerte o cuenta bancaria para pagar proveedores.
                </p>
              )
            : loadingSuppliers
              ? (
                  <p className="text-xs text-muted-foreground">Cargando proveedores…</p>
                )
              : suppliers.length === 0 && !loadingSuppliers
                ? (
                    <p className="text-xs text-muted-foreground">
                      No hay proveedores con deuda pendiente.
                    </p>
                  )
                : (
                    <>
                      <Select
                        value={supplierId}
                        onValueChange={setSupplierId}
                        options={supplierOptions}
                        placeholder="Proveedor con deuda"
                      />
                      {selectedSupplier && (
                        <div className="space-y-1">
                          <p className="text-[11.5px] text-muted-foreground">
                            Deuda total: $
                            {selectedSupplier.totalOutstanding.toLocaleString('es-CO')}
                          </p>
                          {loadingInvoices && (
                            <p className="text-[11px] text-muted-foreground">
                              Cargando facturas…
                            </p>
                          )}
                          {!loadingInvoices && invoices.length === 0 && (
                            <p className="text-[11px] text-muted-foreground">
                              Sin facturas registradas.
                            </p>
                          )}
                          {!loadingInvoices && invoices.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {invoices.map(inv => (
                                <li
                                  key={inv.payableId}
                                  className="
                                    flex items-center justify-between
                                    text-[11px] text-muted-foreground
                                  "
                                >
                                  <span className="truncate">
                                    {inv.invoiceNumber
                                      ? `N° ${inv.invoiceNumber}`
                                      : `Sin N° · ${new Date(inv.purchasedAt).toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' })}`}
                                  </span>
                                  <span
                                    className="
                                      ml-3 shrink-0 font-medium tabular-nums
                                    "
                                  >
                                    {`$${inv.outstanding.toLocaleString('es-CO')}`}
                                    {' '}
                                    <span className={
                                      inv.status === 'partial'
                                        ? 'text-blue-500'
                                        : 'text-amber-500'
                                    }
                                    >
                                      {`(${inv.status === 'partial' ? 'Parcial' : 'Pendiente'})`}
                                    </span>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <Select
                        value={fromAccountId}
                        onValueChange={setFromAccountId}
                        options={fromOptions}
                        placeholder="Desde (contenedor de origen)"
                      />
                      <input
                        className={cashInputCls}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="Monto a pagar"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                      />
                      <input
                        className={cashInputCls}
                        placeholder="Nota (opcional)"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                      />
                      {error && (
                        <div className="text-xs text-destructive">{error}</div>
                      )}
                    </>
                  )}
        </div>

        {/* Footer */}
        <div className="
          flex shrink-0 gap-2.5 border-t border-border bg-background px-[22px]
          pt-4 pb-[22px]
        "
        >
          <Button
            variant="outline"
            className="h-11 px-[18px]"
            disabled={isPending}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            className="h-11 flex-1"
            disabled={
              isPending
              || !hasEligible
              || !supplierId
              || !fromAccountId
              || !amount
              || suppliers.length === 0
            }
            onClick={submit}
          >
            Registrar pago
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── TreasuryActions ───────────────────────────────────────────────────────────

type TreasuryActionsProps = {
  accountRows: TreasuryAccountRow[];
  /** Called to open the TransferWizard (no pre-fill). */
  onOpenWizard: () => void;
  /** Called to open the CreateSlideover. */
  onOpenSlideover: () => void;
};

/**
 * Action buttons row: "Mover dinero" → TransferWizard, "Agregar lugar" → CreateSlideover,
 * "Registrar gasto" → GastoModal, "Pagar proveedor" → SupplierPaymentModal.
 * Wizard and slideover state is owned by TreasuryPageClient (shared with MoneyFlow).
 */
export function TreasuryActions({
  accountRows,
  onOpenWizard,
  onOpenSlideover,
}: TreasuryActionsProps) {
  const [gastoOpen, setGastoOpen] = useState(false);
  const [supplierPayOpen, setSupplierPayOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Button row */}
      <div className="flex gap-3.5">
        <button
          type="button"
          onClick={onOpenWizard}
          className="
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border border-transparent bg-primary px-5 text-[15px] font-semibold
            text-primary-foreground transition-colors
            hover:bg-primary/90
          "
        >
          <ArrowRightLeft className="size-[17px]" />
          Mover dinero
        </button>

        <button
          type="button"
          onClick={onOpenSlideover}
          className="
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border border-input bg-card px-5 text-[15px] font-semibold
            text-foreground transition-colors
            hover:bg-muted
          "
        >
          <Plus className="size-[17px]" />
          Agregar lugar
        </button>

        <button
          type="button"
          onClick={() => setGastoOpen(true)}
          className="
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border border-input bg-card px-5 text-[15px] font-semibold
            text-foreground transition-colors
            hover:bg-muted
          "
        >
          <Tag className="size-[17px]" />
          Registrar gasto
        </button>

        <button
          type="button"
          onClick={() => setSupplierPayOpen(true)}
          className="
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border border-input bg-card px-5 text-[15px] font-semibold
            text-foreground transition-colors
            hover:bg-muted
          "
        >
          <Building2 className="size-[17px]" />
          Pagar proveedor
        </button>
      </div>

      {/* Gasto modal */}
      <GastoModal
        accountRows={accountRows}
        open={gastoOpen}
        onClose={() => setGastoOpen(false)}
      />

      {/* Supplier payment modal */}
      <SupplierPaymentModal
        accountRows={accountRows}
        open={supplierPayOpen}
        onClose={() => setSupplierPayOpen(false)}
      />
    </div>
  );
}
