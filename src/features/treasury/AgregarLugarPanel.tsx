'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createCajaFuerte } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { cashInputCls } from '@/features/cash/cash-ui';

type AgregarLugarPanelProps = {
  onClose: () => void;
};

/**
 * "Agregar lugar" inline panel — creates a new caja fuerte or banco account.
 * Used in the TreasuryActions bar (View B).
 * Reuses createCajaFuerte / createBanco server actions.
 */
export function AgregarLugarPanel({ onClose }: AgregarLugarPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Slice A: only caja fuerte creation is wired inline.
  // Banco creation requires a linked payment method (enforced by the action) —
  // users should use the Settings → Métodos de pago flow which auto-creates accounts.

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError('Ingresá un nombre');
      return;
    }
    const bal = Number.parseFloat(openingBalance) || 0;
    startTransition(async () => {
      try {
        const res = await createCajaFuerte(name.trim(), bal);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onClose();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Agregar caja fuerte</p>
      <p className="text-xs text-muted-foreground">
        Las cuentas bancarias se crean automáticamente desde
        Configuración → Métodos de pago.
      </p>

      <input
        className={cashInputCls}
        placeholder="Nombre (ej: Cajón de la Cocina)"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />

      <input
        className={cashInputCls}
        type="number"
        inputMode="decimal"
        min="0"
        placeholder="Saldo inicial (opcional)"
        value={openingBalance}
        onChange={e => setOpeningBalance(e.target.value)}
      />

      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="flex gap-2">
        <Button size="sm" disabled={isPending || !name.trim()} onClick={submit}>
          Crear
        </Button>
        <Button size="sm" variant="ghost" disabled={isPending} onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
