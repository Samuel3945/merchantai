'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { transferEntreCajas } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import { validateMoverDinero } from './moverDineroValidation';

/**
 * "Mover dinero" form — internal transfer between treasury containers.
 * Calls the existing transferEntreCajas server action; no new backend.
 * Client-side validation uses the pure validateMoverDinero helper.
 *
 * POS cajas are excluded: only caja_fuerte and banco accounts are eligible
 * as origin/destination (POS balances are session-derived and read-only).
 */
export function MoverDineroForm({
  accountRows,
}: {
  accountRows: TreasuryAccountRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Only caja_fuerte and banco accounts are eligible for explicit transfers.
  // POS cajas are session-derived and must not be transfer targets.
  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );

  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  const toOptions = eligible
    .filter(a => a.id !== fromId)
    .map(a => ({
      value: a.id,
      label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
    }));

  // Need at least 2 eligible containers to offer a transfer.
  if (eligible.length < 2) {
    return null;
  }

  function reset() {
    setFromId('');
    setToId('');
    setAmount('');
    setReason('');
    setError(null);
    setSuccess(false);
  }

  function submit() {
    setError(null);
    setSuccess(false);

    const validationError = validateMoverDinero({ fromId, toId, amount });
    if (validationError) {
      setError(validationError);
      return;
    }

    startTransition(async () => {
      try {
        const res = await transferEntreCajas(
          fromId,
          toId,
          amount,
          reason.trim() || null,
        );
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
        Mover dinero
      </button>
    );
  }

  return (
    <div className="
      mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3
    "
    >
      <p className="text-xs font-medium">Mover dinero entre contenedores</p>

      <Select
        value={fromId}
        onValueChange={(v) => {
          setFromId(v);
          if (v === toId) {
            setToId('');
          }
        }}
        options={fromOptions}
        placeholder="Desde (origen)"
      />

      <Select
        value={toId}
        onValueChange={setToId}
        options={toOptions}
        placeholder="Hacia (destino)"
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
        placeholder="Nota (opcional)"
        value={reason}
        onChange={e => setReason(e.target.value)}
      />

      {error && (
        <div className="text-xs text-destructive">{error}</div>
      )}

      {success && (
        <div className="text-xs text-success">Transferencia registrada.</div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !fromId || !toId || !amount}
          onClick={submit}
        >
          Transferir
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
