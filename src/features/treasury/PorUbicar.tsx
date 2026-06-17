'use client';

import type { PendingHandover, TreasuryAccountRow } from '@/libs/treasury';
import { Clock, Coins, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  placeHandoverAsGasto,
  placeHandoverToBanco,
  placeHandoverToCajaFuerte,
} from '@/actions/treasury-placement';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls, money } from '@/features/cash/cash-ui';

type PlacementDestination = 'banco' | 'caja_fuerte' | 'gasto';

/**
 * Inline expander for placing a single handover.
 * Reuses the same placeHandover* actions from HandoverPlacementRow in TreasuryConsole.
 */
function HandoverCard(props: {
  handover: PendingHandover;
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [destination, setDestination] = useState<PlacementDestination>('banco');
  const [destAccountId, setDestAccountId] = useState('');
  const [amount, setAmount] = useState(String(props.handover.remaining));
  const [error, setError] = useState<string | null>(null);

  const bankOptions = props.bankAccounts.map(a => ({ value: a.id, label: a.name }));
  const vaultOptions = props.cajaFuerteAccounts.map(a => ({ value: a.id, label: a.name }));

  const destinationOptions: { value: PlacementDestination; label: string }[] = [
    ...(props.bankAccounts.length > 0 ? [{ value: 'banco' as const, label: 'Banco' }] : []),
    ...(props.cajaFuerteAccounts.length > 0
      ? [{ value: 'caja_fuerte' as const, label: 'Caja fuerte' }]
      : []),
    { value: 'gasto' as const, label: 'Gasto (salida de tesorería)' },
  ];

  const dateLabel = props.handover.createdAt.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        let res;
        if (destination === 'banco') {
          if (!destAccountId) {
            setError('Seleccioná un banco destino');
            return;
          }
          res = await placeHandoverToBanco(props.handover.id, destAccountId, amount);
        } else if (destination === 'caja_fuerte') {
          if (!destAccountId) {
            setError('Seleccioná una caja fuerte destino');
            return;
          }
          res = await placeHandoverToCajaFuerte(props.handover.id, destAccountId, amount);
        } else {
          res = await placeHandoverAsGasto(props.handover.id, amount);
        }
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setAmount('');
        setDestAccountId('');
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  return (
    <div
      className="
        relative flex flex-col gap-0 overflow-hidden rounded-[14px] border
        border-border bg-card transition-[border-color,box-shadow]
        hover:border-warn hover:shadow-sm
      "
    >
      {/* Left warn bar */}
      <span
        className="absolute inset-y-3.5 left-0 w-[3px] rounded-r-full bg-warn"
        aria-hidden
      />

      {/* Card row */}
      <div className="flex items-center gap-4 px-[18px] py-4">
        {/* Icon */}
        <span
          className="
            flex size-[42px] shrink-0 items-center justify-center rounded-[11px]
            bg-warn/10 text-warn
          "
        >
          <Coins className="size-5" />
        </span>

        {/* Origin + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-[650]">Cierre de Caja</span>
            <span
              className="
                inline-flex h-5 items-center rounded-full bg-accent px-2.5
                text-[10.5px] font-semibold text-secondary-foreground
              "
            >
              Pendiente de ubicar
            </span>
          </div>
          <div className="
            mt-1 flex items-center gap-3.5 text-xs text-muted-foreground
          "
          >
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {dateLabel}
            </span>
          </div>
        </div>

        {/* Amount */}
        <div className="font-display text-[19px] font-[650] tabular-nums">
          {money(props.handover.remaining)}
        </div>

        {/* Ubicar button */}
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => setOpen(v => !v)}
        >
          <Lock className="size-3.5" />
          Ubicar
        </Button>
      </div>

      {/* Inline expander */}
      {open && (
        <div className="border-t border-border bg-muted/30 px-[18px] py-4">
          <p className="mb-3 text-xs font-medium text-secondary-foreground">
            ¿A dónde va esta plata?
          </p>

          <div className="space-y-2">
            {destinationOptions.length > 0 && (
              <Select
                value={destination}
                onValueChange={(v) => {
                  setDestination(v as PlacementDestination);
                  setDestAccountId('');
                }}
                options={destinationOptions}
                placeholder="¿Dónde va el dinero?"
              />
            )}

            {destination === 'banco' && bankOptions.length > 0 && (
              <Select
                value={destAccountId}
                onValueChange={setDestAccountId}
                options={bankOptions}
                placeholder="¿A qué banco?"
              />
            )}

            {destination === 'caja_fuerte' && vaultOptions.length > 0 && (
              <Select
                value={destAccountId}
                onValueChange={setDestAccountId}
                options={vaultOptions}
                placeholder="¿A qué caja fuerte?"
              />
            )}

            <input
              className={cashInputCls}
              type="number"
              inputMode="decimal"
              min="0"
              max={props.handover.remaining}
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />

            {error && <div className="text-xs text-destructive">{error}</div>}

            <div className="flex gap-2">
              <Button size="sm" disabled={isPending || amount === ''} onClick={submit}>
                Confirmar ubicación
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending}
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type PorUbicarProps = {
  pendingHandovers: PendingHandover[];
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
};

/**
 * "Plata por ubicar" section — shown only when there are pending handovers.
 * Header: total sin ubicar + count. One card per handover with an inline
 * placement expander using the existing placeHandover* actions.
 */
export function PorUbicar({ pendingHandovers, bankAccounts, cajaFuerteAccounts }: PorUbicarProps) {
  if (pendingHandovers.length === 0) {
    return null;
  }

  const total = pendingHandovers.reduce((s, h) => s + h.remaining, 0);
  const count = pendingHandovers.length;

  return (
    <div className="rounded-xl border border-border bg-card p-[22px] shadow-xs">
      {/* Section header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">
            Plata por ubicar
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Esta plata salió de un cierre y todavía no dijiste dónde quedó.
            Ubicala para no perderle el rastro.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="
            font-display text-[22px] font-[650] text-warn tabular-nums
          "
          >
            {money(total)}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {count}
            {' '}
            {count === 1 ? 'solicitud' : 'solicitudes'}
          </div>
        </div>
      </div>

      {/* Handover cards */}
      <div className="mt-[18px] flex flex-col gap-2.5">
        {pendingHandovers.map(h => (
          <HandoverCard
            key={h.id}
            handover={h}
            bankAccounts={bankAccounts}
            cajaFuerteAccounts={cajaFuerteAccounts}
          />
        ))}
      </div>
    </div>
  );
}
