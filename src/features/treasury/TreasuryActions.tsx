'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { ArrowRightLeft, Plus, Tag } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recordGasto, transferEntreCajas } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';
import { AgregarLugarPanel } from './AgregarLugarPanel';
import { validateGasto } from './gastoValidation';
import { validateMoverDinero } from './moverDineroValidation';

// ── Expanded inline form: Mover dinero ───────────────────────────────────────

function MoverDineroFormExpanded({
  accountRows,
  onClose,
}: {
  accountRows: TreasuryAccountRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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

  if (eligible.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        Necesitás al menos 2 contenedores (caja fuerte o banco) para mover dinero.
      </p>
    );
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
        setFromId('');
        setToId('');
        setAmount('');
        setReason('');
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Intentá de nuevo.');
      }
    });
  }

  return (
    <div className="space-y-3">
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
      {error && <div className="text-xs text-destructive">{error}</div>}
      {success && <div className="text-xs text-success">Transferencia registrada.</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={isPending || !fromId || !toId || !amount}
          onClick={submit}
        >
          Transferir
        </Button>
        <Button size="sm" variant="ghost" disabled={isPending} onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const eligible = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );
  const fromOptions = eligible.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
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
        setFromAccountId('');
        setAmount('');
        setCategory('');
        setDescription('');
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

// ── TreasuryActions: 3-button action bar ─────────────────────────────────────

type ActivePanel = 'mover' | 'agregar' | 'gasto' | null;

type TreasuryActionsProps = {
  accountRows: TreasuryAccountRow[];
};

/**
 * Action buttons row: "Mover dinero" (primary), "Agregar lugar", "Registrar gasto".
 * Each button expands an inline panel wired to the existing server actions.
 * Matches the View B action bar row.
 */
export function TreasuryActions({ accountRows }: TreasuryActionsProps) {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  function toggle(panel: Exclude<ActivePanel, null>) {
    setActivePanel(prev => (prev === panel ? null : panel));
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Button row */}
      <div className="flex gap-3.5">
        <button
          type="button"
          onClick={() => toggle('mover')}
          className={`
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border border-transparent px-5 text-[15px] font-semibold
            transition-colors
            ${
    activePanel === 'mover'
      ? 'bg-primary/90 text-primary-foreground'
      : `
        bg-primary text-primary-foreground
        hover:bg-primary/90
      `
    }
          `}
        >
          <ArrowRightLeft className="size-[17px]" />
          Mover dinero
        </button>

        <button
          type="button"
          onClick={() => toggle('agregar')}
          className={`
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border px-5 text-[15px] font-semibold transition-colors
            ${
    activePanel === 'agregar'
      ? 'border-primary bg-primary/5 text-primary'
      : `
        border-input bg-card text-foreground
        hover:bg-muted
      `
    }
          `}
        >
          <Plus className="size-[17px]" />
          Agregar lugar
        </button>

        <button
          type="button"
          onClick={() => toggle('gasto')}
          className={`
            flex h-12 flex-1 items-center justify-center gap-2 rounded-[10px]
            border px-5 text-[15px] font-semibold transition-colors
            ${
    activePanel === 'gasto'
      ? 'border-primary bg-primary/5 text-primary'
      : `
        border-input bg-card text-foreground
        hover:bg-muted
      `
    }
          `}
        >
          <Tag className="size-[17px]" />
          Registrar gasto
        </button>
      </div>

      {/* Inline panels */}
      {activePanel === 'mover' && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p className="mb-3 text-sm font-semibold">Mover dinero entre contenedores</p>
          <MoverDineroFormExpanded
            accountRows={accountRows}
            onClose={() => setActivePanel(null)}
          />
        </div>
      )}

      {activePanel === 'agregar' && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <AgregarLugarPanel onClose={() => setActivePanel(null)} />
        </div>
      )}

      {activePanel === 'gasto' && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p className="mb-3 text-sm font-semibold">Registrar gasto</p>
          <GastoFormExpanded
            accountRows={accountRows}
            onClose={() => setActivePanel(null)}
          />
        </div>
      )}
    </div>
  );
}
