'use client';

import type { ReactNode } from 'react';
import type { SupplierInvoiceRow, SupplierOutstandingRow } from '@/actions/treasury';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { ArrowRightLeft, Building2, Plus, Tag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { getSupplierInvoicesAction, listSuppliersWithOutstanding, recordGasto, recordSelectedSupplierPaymentFromConsole } from '@/actions/treasury';
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

/**
 * Labeled field wrapper for the gasto form. Each field gets a plain-language
 * question as a persistent label plus an optional one-line hint, so a
 * non-technical shop owner understands exactly what to enter (the placeholder
 * alone disappears as soon as they start typing).
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13.5px] font-medium text-foreground">{label}</label>
      {hint && (
        <p className="text-[11.5px] leading-snug text-muted-foreground">{hint}</p>
      )}
      {children}
    </div>
  );
}

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
            Anotá un pago que hiciste con la plata del negocio (arriendo,
            servicios, domicilios, etc.). Decinos de dónde salió la plata y por
            qué la gastaste.
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
                  <Field
                    label="¿De dónde sale la plata?"
                    hint="Elegí la caja fuerte o la cuenta del banco de donde vas a sacar el dinero para pagar."
                  >
                    <Select
                      value={fromAccountId}
                      onValueChange={setFromAccountId}
                      options={fromOptions}
                      placeholder="Elegí un lugar"
                    />
                  </Field>
                  <Field
                    label="¿Qué tipo de gasto es?"
                    hint="Sirve para ordenar tus gastos y ver en qué se te va la plata."
                  >
                    <Select
                      value={category}
                      onValueChange={setCategory}
                      options={categoryOptions}
                      placeholder="Elegí una categoría"
                    />
                  </Field>
                  <Field
                    label={
                      category === 'otros'
                        ? '¿Por qué pagaste esto? (obligatorio)'
                        : '¿Por qué pagaste esto? (opcional)'
                    }
                    hint="Escribilo en pocas palabras para acordarte después."
                  >
                    <input
                      className={cashInputCls}
                      placeholder={
                        category === 'otros'
                          ? 'Ej: arreglo del freezer'
                          : 'Ej: recibo de luz de junio'
                      }
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="¿Cuánto pagaste?"
                    hint="El valor total de la salida de plata, en pesos."
                  >
                    <input
                      className={cashInputCls}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      placeholder="Ej: 50000"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="¿Qué día fue el gasto?"
                    hint="Si fue hoy, dejalo como está."
                  >
                    <input
                      className={cashInputCls}
                      type="date"
                      value={incurredOn}
                      max={today}
                      onChange={e => setIncurredOn(e.target.value)}
                    />
                  </Field>
                  {error && (
                    <div className="text-xs text-destructive">{error}</div>
                  )}
                </>
              )
            : (
                <p className="text-xs text-muted-foreground">
                  Para registrar un gasto primero necesitás una caja fuerte o una
                  cuenta de banco. Creá una con el botón «Agregar lugar».
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
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<SupplierInvoiceRow[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  // Per-invoice selection + (possibly partial) amount, keyed by payableId.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});

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
        // Default: every invoice ticked, full outstanding each. The owner unticks
        // the ones to skip or edits an amount to pay partially.
        setSelected(new Set(res.data.map(i => i.payableId)));
        setAmounts(
          Object.fromEntries(res.data.map(i => [i.payableId, String(i.outstanding)])),
        );
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

  // Load suppliers with outstanding when the modal opens. MUST be an effect keyed
  // on `open`: the Dialog's onOpenChange does NOT fire when `open` is controlled
  // externally (the parent button sets it), so the old handleOpen-based load never
  // ran — that is why the list was always empty and the query never executed.
  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) {
        return;
      }
      setLoadingSuppliers(true);
      setError(null);
      try {
        const res = await listSuppliersWithOutstanding();
        if (!active) {
          return;
        }
        if (res.ok) {
          setSuppliers(res.data);
        } else {
          setError(res.error);
        }
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : 'Error al cargar proveedores');
        }
      } finally {
        if (active) {
          setLoadingSuppliers(false);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [open]);

  // Reset on close. onOpenChange DOES fire for Radix-initiated closes (escape /
  // overlay click); explicit Cancelar/submit call onClose directly.
  function handleOpen(isOpen: boolean) {
    if (!isOpen) {
      setSupplierId('');
      setInvoices([]);
      setSelected(new Set());
      setAmounts({});
      setLoadingInvoices(false);
      onClose();
    }
  }

  const supplierOptions = suppliers.map(s => ({
    value: s.supplierId,
    label: `${s.name} — $${s.totalOutstanding.toLocaleString('es-CO')} pendiente`,
  }));

  const selectedSupplier = suppliers.find(s => s.supplierId === supplierId);

  function toggleInvoice(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function setInvoiceAmount(id: string, value: string) {
    setAmounts(prev => ({ ...prev, [id]: value }));
  }

  const allSelected = invoices.length > 0 && invoices.every(i => selected.has(i.payableId));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(invoices.map(i => i.payableId)));
  }

  // Sum of the amounts entered on ticked invoices.
  const selectedTotal = invoices
    .filter(i => selected.has(i.payableId))
    .reduce((s, i) => s + (Number.parseFloat(amounts[i.payableId] ?? '0') || 0), 0);

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
    const chosen = invoices.filter(i => selected.has(i.payableId));
    if (chosen.length === 0) {
      setError('Seleccioná al menos una factura');
      return;
    }
    const selections: { payableId: string; amount: number }[] = [];
    for (const inv of chosen) {
      const amt = Number.parseFloat(amounts[inv.payableId] ?? '');
      if (Number.isNaN(amt) || amt <= 0) {
        setError('El monto de cada factura seleccionada debe ser mayor a 0');
        return;
      }
      if (amt > inv.outstanding + 0.005) {
        setError(
          `El monto de una factura ($${amt.toLocaleString('es-CO')}) supera su saldo pendiente ($${inv.outstanding.toLocaleString('es-CO')})`,
        );
        return;
      }
      selections.push({ payableId: inv.payableId, amount: amt });
    }
    startTransition(async () => {
      try {
        const res = await recordSelectedSupplierPaymentFromConsole({
          supplierId,
          fromAccountId,
          selections,
          note: note.trim() || null,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Reset and close.
        setSupplierId('');
        setFromAccountId('');
        setNote('');
        setInvoices([]);
        setSelected(new Set());
        setAmounts({});
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
                    error
                      ? (
                          <p className="text-xs text-destructive">{error}</p>
                        )
                      : (
                          <p className="text-xs text-muted-foreground">
                            No hay proveedores con deuda pendiente.
                          </p>
                        )
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
                            <div className="mt-1 space-y-2">
                              <div className="flex items-center justify-between">
                                <button
                                  type="button"
                                  onClick={toggleAll}
                                  className="
                                    text-[11px] font-medium text-primary
                                    hover:underline
                                  "
                                >
                                  {allSelected ? 'Quitar todas' : 'Seleccionar todas'}
                                </button>
                                <span className="
                                  text-[11px] font-semibold text-foreground
                                  tabular-nums
                                "
                                >
                                  Total a pagar: $
                                  {selectedTotal.toLocaleString('es-CO')}
                                </span>
                              </div>
                              <ul className="space-y-1.5">
                                {invoices.map((inv) => {
                                  const isChecked = selected.has(inv.payableId);
                                  return (
                                    <li
                                      key={inv.payableId}
                                      className="
                                        rounded-md border border-border p-2
                                      "
                                    >
                                      <label className="
                                        flex cursor-pointer items-center gap-2
                                      "
                                      >
                                        <input
                                          type="checkbox"
                                          className="size-4 accent-primary"
                                          checked={isChecked}
                                          onChange={() => toggleInvoice(inv.payableId)}
                                        />
                                        <span className="
                                          flex-1 truncate text-[12px]
                                          text-foreground
                                        "
                                        >
                                          {inv.invoiceNumber
                                            ? `N° ${inv.invoiceNumber}`
                                            : `Sin N° · ${new Date(inv.purchasedAt).toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' })}`}
                                        </span>
                                        <span className="
                                          shrink-0 text-[10.5px]
                                          text-muted-foreground tabular-nums
                                        "
                                        >
                                          Pendiente: $
                                          {inv.outstanding.toLocaleString('es-CO')}
                                        </span>
                                      </label>
                                      {isChecked && (
                                        <input
                                          className={`
                                            ${cashInputCls}
                                            mt-1.5
                                          `}
                                          type="number"
                                          inputMode="decimal"
                                          min="0"
                                          step="any"
                                          placeholder="Monto a pagar (parcial o total)"
                                          value={amounts[inv.payableId] ?? ''}
                                          onChange={e =>
                                            setInvoiceAmount(inv.payableId, e.target.value)}
                                        />
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
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
              || selected.size === 0
              || selectedTotal <= 0
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
