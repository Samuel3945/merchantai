'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { ArrowRightLeft, Plus, Tag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recordGasto } from '@/actions/treasury';
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
 * "Registrar gasto" → GastoModal (window, not an inline expander).
 * Wizard and slideover state is owned by TreasuryPageClient (shared with MoneyFlow).
 */
export function TreasuryActions({
  accountRows,
  onOpenWizard,
  onOpenSlideover,
}: TreasuryActionsProps) {
  const [gastoOpen, setGastoOpen] = useState(false);

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
      </div>

      {/* Gasto modal */}
      <GastoModal
        accountRows={accountRows}
        open={gastoOpen}
        onClose={() => setGastoOpen(false)}
      />
    </div>
  );
}
