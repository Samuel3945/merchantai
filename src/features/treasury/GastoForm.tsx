'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recordGasto } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import { validateGasto } from './gastoValidation';

/**
 * "Registrar gasto" form — records an expense debited from a mandatory source
 * container (Desde). Calls the existing recordGasto server action; no new backend.
 * Client-side validation uses the pure validateGasto helper.
 *
 * Only caja_fuerte and banco accounts are eligible as the expense source.
 * POS cajas are session-derived and not eligible for direct expense debits.
 */
export function GastoForm({
  accountRows,
}: {
  accountRows: TreasuryAccountRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [fromAccountId, setFromAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Only caja_fuerte and banco accounts can be source containers for gastos.
  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );

  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  function reset() {
    setFromAccountId('');
    setAmount('');
    setCategory('');
    setDescription('');
    setError(null);
  }

  function submit() {
    setError(null);
    setSuccess(false);

    const validationError = validateGasto({ fromAccountId, amount, category });
    if (validationError) {
      setError(validationError);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    startTransition(async () => {
      try {
        const res = await recordGasto({
          fromAccountId,
          amount,
          category: category.trim(),
          description: description.trim() || null,
          incurredOn: today,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSuccess(true);
        reset();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Intentá de nuevo.');
      }
    });
  }

  if (eligible.length === 0) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          text-xs font-medium text-primary
          hover:underline
        "
      >
        Registrar gasto
      </button>
    );
  }

  return (
    <div className="
      mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3
    "
    >
      <p className="text-xs font-medium">Registrar gasto</p>

      {/* Desde — mandatory source container */}
      <Select
        value={fromAccountId}
        onValueChange={setFromAccountId}
        options={fromOptions}
        placeholder="Desde (contenedor de origen)"
      />

      <input
        className={cashInputCls}
        placeholder="Categoría (ej: servicios, arriendo)"
        value={category}
        onChange={e => setCategory(e.target.value)}
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

      <input
        className={cashInputCls}
        placeholder="Descripción (opcional)"
        value={description}
        onChange={e => setDescription(e.target.value)}
      />

      {error && (
        <div className="text-xs text-destructive">{error}</div>
      )}

      {success && (
        <div className="text-xs text-success">Gasto registrado.</div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !fromAccountId || !amount || !category}
          onClick={submit}
        >
          Registrar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            reset();
            setSuccess(false);
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
