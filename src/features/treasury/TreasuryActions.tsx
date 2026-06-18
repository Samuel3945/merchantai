'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { ArrowRightLeft, Plus, Tag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recordGasto } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import {
  TREASURY_EXPENSE_CATEGORIES,
  TREASURY_EXPENSE_CATEGORY_LABELS,
} from './expenseCategories';
import { validateGasto } from './gastoValidation';

// ── Expanded inline form: Registrar gasto ────────────────────────────────────

function GastoFormExpanded({
  accountRows,
  onClose,
}: {
  accountRows: TreasuryAccountRow[];
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
  const [success, setSuccess] = useState(false);

  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );
  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  const categoryOptions = TREASURY_EXPENSE_CATEGORIES.map(cat => ({
    value: cat,
    label: TREASURY_EXPENSE_CATEGORY_LABELS[cat],
  }));

  if (eligible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Necesitás al menos una caja fuerte o cuenta bancaria para registrar gastos.
      </p>
    );
  }

  function submit() {
    setError(null);
    setSuccess(false);
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
        setSuccess(true);
        setFromAccountId('');
        setAmount('');
        setCategory('');
        setDescription('');
        setIncurredOn(new Date().toISOString().slice(0, 10));
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Intentá de nuevo.');
      }
    });
  }

  return (
    <div className="space-y-3">
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
      {category === 'otros' && (
        <input
          className={cashInputCls}
          placeholder="Motivo del gasto (requerido para Otros)"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      )}
      {category !== 'otros' && (
        <input
          className={cashInputCls}
          placeholder="Descripción (opcional)"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      )}
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
        <label className="text-xs text-muted-foreground">Fecha del gasto</label>
        <input
          className={cashInputCls}
          type="date"
          value={incurredOn}
          max={today}
          onChange={e => setIncurredOn(e.target.value)}
        />
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      {success && <div className="text-xs text-success">Gasto registrado.</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={isPending || !fromAccountId || !amount || !category}
          onClick={submit}
        >
          Registrar
        </Button>
        <Button size="sm" variant="ghost" disabled={isPending} onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </div>
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
 * "Registrar gasto" → inline expander (unchanged).
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
          onClick={() => setGastoOpen(v => !v)}
          className={`
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border px-5 text-[15px] font-semibold transition-colors
            ${gastoOpen
      ? 'border-primary bg-primary/5 text-primary'
      : `
        border-input bg-card text-foreground
        hover:bg-muted
      `}
          `}
        >
          <Tag className="size-[17px]" />
          Registrar gasto
        </button>
      </div>

      {/* Gasto inline panel */}
      {gastoOpen && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p className="mb-3 text-sm font-semibold">Registrar gasto</p>
          <GastoFormExpanded
            accountRows={accountRows}
            onClose={() => setGastoOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
