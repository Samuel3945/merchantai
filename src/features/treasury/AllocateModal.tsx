'use client';

import type { PendingHandover, TreasuryAccountRow } from '@/libs/treasury';
import { AlertTriangle, Check, Clock, Landmark, Lock, Monitor, Tag, Trash2, User, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  placeHandoverAsGasto,
  placeHandoverAsLossAction,
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

type DestKey = 'caja_fuerte' | 'banco' | 'gasto' | 'perdida';

const DEST_OPTIONS: {
  k: DestKey;
  label: string;
  sub: string;
  quote: string;
  warn?: boolean;
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
    k: 'perdida',
    label: 'Se perdió',
    sub: 'Un billete que se cayó / faltante',
    quote: 'No está, se perdió',
    warn: true,
    Icon: Trash2,
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
 * Recap header shows origin (De dónde salió), date (Cuándo), cashier (Quién la tenía).
 * Destination is chosen via large tappable rows:
 *   - Caja fuerte (cofre)
 *   - Cuenta bancaria (banco)
 *   - Fue un gasto
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
        } else if (dest === 'perdida') {
          // 'perdida': records a faltante. Category enforced server-side.
          const noteText = note.trim() || null;
          res = await placeHandoverAsLossAction(handover.id, amt, noteText);
        } else {
          // 'gasto' maps to placeHandoverAsGasto. The note is optional.
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
  // 'gasto' and 'perdida' are always visible (no account picker required).
  const visibleOptions = DEST_OPTIONS.filter((d) => {
    if (d.k === 'caja_fuerte') {
      return cajaFuerteAccounts.length > 0;
    }
    if (d.k === 'banco') {
      return bankAccounts.length > 0;
    }
    return true; // gasto and perdida always available
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
      <DialogContent className="
        flex max-h-[90dvh] max-w-[480px] flex-col gap-0 overflow-hidden p-0
      "
      >
        {/* Recap header */}
        <div className="
          shrink-0 border-b border-border bg-warn/10 px-[22px] py-5
        "
        >
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
            {/* De dónde salió */}
            <div>
              <div className="
                mb-0.5 text-[10.5px] font-bold tracking-[.06em]
                text-muted-foreground uppercase
              "
              >
                De dónde salió
              </div>
              <span className="inline-flex items-center gap-1">
                <Monitor className="size-3 text-muted-foreground" />
                {handover.origin}
              </span>
            </div>

            {/* Cuándo */}
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

            {/* Quién la tenía — omit when null */}
            {handover.cashierName && (
              <div>
                <div className="
                  mb-0.5 text-[10.5px] font-bold tracking-[.06em]
                  text-muted-foreground uppercase
                "
                >
                  Quién la tenía
                </div>
                <span className="inline-flex items-center gap-1">
                  <User className="size-3 text-muted-foreground" />
                  {handover.cashierName}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Body — scrolls when content exceeds the viewport so the footer stays reachable */}
        <div className="min-h-0 flex-1 overflow-y-auto p-[22px]">
          <h3 className="text-[15px] font-semibold">¿Dónde quedó esta plata?</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Acordate qué hiciste con ella: dónde la pusiste o dónde está ahora.
          </p>

          {/* Destination choices */}
          <div className="mt-4 flex flex-col gap-2.5">
            {visibleOptions.map((d) => {
              const selected = dest === d.k;
              const isWarn = d.warn === true;
              return (
                <button
                  key={d.k}
                  type="button"
                  onClick={() => handleDestChange(d.k)}
                  className={`
                    flex items-center gap-3 rounded-[12px] border px-3.5 py-3
                    text-left transition-[border-color,background-color]
                    ${selected && isWarn
                  ? 'border-destructive bg-destructive/5'
                  : selected
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
                      ${selected && isWarn
                  ? 'bg-destructive text-white'
                  : selected
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
                    <Check className={`
                      size-[18px] shrink-0
                      ${isWarn
                      ? `text-destructive`
                      : `text-primary`}
                    `}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Warning copy for "Se perdió" — lowers utilidad */}
          {dest === 'perdida' && (
            <div className="
              mt-3 flex items-start gap-2 rounded-[10px] border
              border-destructive/30 bg-destructive/5 px-3 py-2.5
            "
            >
              <AlertTriangle className="
                mt-0.5 size-3.5 shrink-0 text-destructive
              "
              />
              <p className="text-[12px] text-destructive">
                Esto baja la utilidad del negocio. Si el billete aparece
                después, podés recuperarlo desde el panel de faltantes.
              </p>
            </div>
          )}

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
                Nota (opcional)
              </span>
              <input
                className={cashInputCls}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder={
                  dest === 'gasto'
                    ? 'Ej: pago del gas, recibo #123'
                    : dest === 'perdida'
                      ? 'Ej: billete que se cayó al contar'
                      : 'Ej: para acordarte después'
                }
              />
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-destructive">{error}</div>
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
