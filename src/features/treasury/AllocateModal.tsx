'use client';

import type { PendingHandover, TreasuryAccountRow } from '@/libs/treasury';
import { Check, Clock, Coins, Landmark, Lock, Tag, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  placeHandoverAsGasto,
  placeHandoverToBanco,
  placeHandoverToCajaFuerte,
} from '@/actions/treasury-placement';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { cashInputCls, money } from '@/features/cash/cash-ui';

// ── Destination option rows ──────────────────────────────────────────────────

type DestKey = 'caja_fuerte' | 'banco' | 'gasto' | 'otro';

const DEST_OPTIONS: {
  k: DestKey;
  label: string;
  sub: string;
  quote: string;
  Icon: React.FC<{ className?: string }>;
}[] = [
  {
    k: 'caja_fuerte',
    label: 'Caja fuerte',
    sub: 'Guardado físicamente',
    quote: 'La guardé físicamente',
    Icon: Lock,
  },
  {
    k: 'banco',
    label: 'Cuenta bancaria',
    sub: 'Consignado o transferido',
    quote: 'La consigné / transferí',
    Icon: Landmark,
  },
  {
    k: 'gasto',
    label: 'Fue un gasto',
    sub: 'Pago de algo del negocio',
    quote: 'Ya se gastó',
    Icon: Tag,
  },
  {
    k: 'otro',
    label: 'Otro lugar',
    sub: 'Lo explico abajo',
    quote: '',
    Icon: Coins,
  },
];

// ── AllocateModal ─────────────────────────────────────────────────────────────

type AllocateModalProps = {
  handover: PendingHandover;
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
  open: boolean;
  onClose: () => void;
};

/**
 * Modal to place a pending handover (Plata por ubicar).
 * Recap header shows date/amount. Destination is chosen via large tappable rows.
 * Wired to placeHandoverToCajaFuerte / placeHandoverToBanco / placeHandoverAsGasto.
 * "Otro lugar" maps to placeHandoverAsGasto with a mandatory note.
 * "Volvió a una caja" is omitted — no existing action supports it cleanly.
 */
export function AllocateModal({
  handover,
  bankAccounts,
  cajaFuerteAccounts,
  open,
  onClose,
}: AllocateModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dest, setDest] = useState<DestKey | ''>('');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(String(handover.remaining));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dateLabel = handover.createdAt.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  function handleDestChange(k: DestKey) {
    setDest(k);
    setAccountId('');
    setError(null);
  }

  const isDisabled
    = !dest
      || (dest === 'otro' && !note.trim())
      || (dest === 'caja_fuerte' && !accountId)
      || (dest === 'banco' && !accountId)
      || isPending;

  function submit() {
    setError(null);
    const amt = amount;
    if (!dest) {
      return;
    }

    startTransition(async () => {
      try {
        let res;
        if (dest === 'banco') {
          res = await placeHandoverToBanco(handover.id, accountId, amt);
        } else if (dest === 'caja_fuerte') {
          res = await placeHandoverToCajaFuerte(handover.id, accountId, amt);
        } else {
          // 'gasto' and 'otro' both map to placeHandoverAsGasto.
          // 'otro' requires a note (enforced by isDisabled guard above).
          const description = note.trim() || null;
          res = await placeHandoverAsGasto(handover.id, amt, description);
        }
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

  // Filtered options — only show destinations that have accounts configured.
  const visibleOptions = DEST_OPTIONS.filter((d) => {
    if (d.k === 'caja_fuerte') {
      return cajaFuerteAccounts.length > 0;
    }
    if (d.k === 'banco') {
      return bankAccounts.length > 0;
    }
    return true; // gasto and otro always available
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-[480px] overflow-hidden p-0">
        {/* Recap header */}
        <div className="border-b border-border bg-warn/10 px-[22px] py-5">
          <div className="flex items-start justify-between">
            <span className="
              text-[11px] font-semibold tracking-widest text-warn uppercase
            "
            >
              Plata por ubicar
            </span>
            <button
              type="button"
              onClick={onClose}
              className="
                flex size-8 items-center justify-center rounded-[9px] border
                border-transparent text-muted-foreground transition-colors
                hover:bg-muted hover:text-foreground
              "
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="
            my-1.5 font-display text-[34px] font-semibold tabular-nums
          "
          >
            {money(handover.remaining)}
          </div>
          <div className="
            flex flex-wrap gap-5 text-[12.5px] text-secondary-foreground
          "
          >
            <div>
              <div className="
                mb-0.5 text-[10.5px] font-bold tracking-[.06em]
                text-muted-foreground uppercase
              "
              >
                Cuándo
              </div>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3 text-muted-foreground" />
                {dateLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-[22px]">
          <h3 className="text-[15px] font-semibold">¿Dónde quedó esta plata?</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Acordate qué hiciste con ella: dónde la pusiste o dónde está ahora.
          </p>

          {/* Destination choices */}
          <div className="mt-4 flex flex-col gap-2.5">
            {visibleOptions.map((d) => {
              const selected = dest === d.k;
              return (
                <button
                  key={d.k}
                  type="button"
                  onClick={() => handleDestChange(d.k)}
                  className={`
                    flex items-center gap-3 rounded-[12px] border px-3.5 py-3
                    text-left transition-[border-color,background-color]
                    ${selected
                  ? 'border-primary bg-primary/5'
                  : `
                    border-border
                    hover:border-input hover:bg-muted/50
                  `}
                  `}
                >
                  <span
                    className={`
                      flex size-9 shrink-0 items-center justify-center
                      rounded-[11px] transition-colors
                      ${selected
                  ? 'bg-primary text-primary-foreground'
                  : `bg-accent text-secondary-foreground`}
                    `}
                  >
                    <d.Icon className="size-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold">
                      {d.label}
                      {' '}
                      <span className="font-normal text-muted-foreground">
                        {'· '}
                        {d.sub}
                      </span>
                    </div>
                    {d.quote && (
                      <div className="text-[11.5px] text-muted-foreground">
                        "
                        {d.quote}
                        "
                      </div>
                    )}
                  </div>
                  {selected && (
                    <Check className="size-[18px] shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Account picker for caja_fuerte */}
          {dest === 'caja_fuerte' && cajaFuerteAccounts.length > 0 && (
            <div className="mt-3.5">
              <Select
                value={accountId}
                onValueChange={setAccountId}
                options={cajaFuerteAccounts.map(a => ({ value: a.id, label: a.name }))}
                placeholder="¿A qué caja fuerte?"
              />
            </div>
          )}

          {/* Account picker for banco */}
          {dest === 'banco' && bankAccounts.length > 0 && (
            <div className="mt-3.5">
              <Select
                value={accountId}
                onValueChange={setAccountId}
                options={bankAccounts.map(a => ({ value: a.id, label: a.name }))}
                placeholder="¿A qué cuenta?"
              />
            </div>
          )}

          {/* Amount */}
          {dest && (
            <div className="mt-3.5 flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-secondary-foreground">
                Monto a ubicar
              </span>
              <input
                className={cashInputCls}
                type="number"
                inputMode="decimal"
                min="0"
                max={handover.remaining}
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
          )}

          {/* Note — optional for most, obligatory for "otro" */}
          {dest && (
            <div className="mt-3 flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-secondary-foreground">
                {dest === 'otro' ? '¿Dónde quedó? (obligatorio)' : 'Nota (opcional)'}
              </span>
              <input
                className={cashInputCls}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder={
                  dest === 'gasto'
                    ? 'Ej: pago del gas, recibo #123'
                    : dest === 'otro'
                      ? 'Ej: se la di a Mirian para el banco mañana'
                      : 'Ej: para acordarte después'
                }
              />
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2.5 px-[22px] pb-[22px]">
          <Button
            variant="outline"
            className="h-11 px-[18px]"
            onClick={onClose}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button
            className="h-11 flex-1"
            disabled={isDisabled}
            onClick={submit}
          >
            <Check className="size-4" />
            Ubicar
            {' '}
            {amount ? money(Number(amount)) : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
