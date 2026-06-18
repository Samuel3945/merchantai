'use client';

import type { RecoverableLoss } from '@/libs/cash-loss';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { Check, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recoverLossAction } from '@/actions/treasury-placement';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { money } from '@/features/cash/cash-ui';

type DestKey = 'caja_fuerte' | 'banco' | 'pendiente';

const DEST_OPTIONS: { k: DestKey; label: string; sub: string }[] = [
  { k: 'caja_fuerte', label: 'Caja fuerte', sub: 'Colocarla en un cofre' },
  { k: 'banco', label: 'Banco', sub: 'Consignarla o transferirla' },
  { k: 'pendiente', label: 'Volver a pendientes', sub: 'Decidir después dónde va' },
];

type RecoverLossModalProps = {
  loss: RecoverableLoss;
  bankAccounts: TreasuryAccountRow[];
  cajaFuerteAccounts: TreasuryAccountRow[];
  open: boolean;
  onClose: () => void;
};

/**
 * Modal to recover a faltante (Slice 2 — "Apareció").
 * Asks where the recovered cash should go:
 *   - Caja fuerte (cofre — requires account picker)
 *   - Banco (requires account picker)
 *   - Volver a pendientes (no picker — creates a new handover)
 */
export function RecoverLossModal({
  loss,
  bankAccounts,
  cajaFuerteAccounts,
  open,
  onClose,
}: RecoverLossModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dest, setDest] = useState<DestKey | ''>('');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    if (!dest) {
      return;
    }

    startTransition(async () => {
      try {
        const res = await recoverLossAction(
          loss.id,
          dest,
          dest === 'pendiente' ? undefined : accountId,
        );
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

  // Filtered: only show destinations with accounts configured (or pendiente always).
  const visibleOptions = DEST_OPTIONS.filter((d) => {
    if (d.k === 'caja_fuerte') {
      return cajaFuerteAccounts.length > 0;
    }
    if (d.k === 'banco') {
      return bankAccounts.length > 0;
    }
    return true; // pendiente always available
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
        flex max-h-[90dvh] max-w-[420px] flex-col gap-0 overflow-hidden p-0
      "
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border px-[22px] py-5">
          <div className="flex items-start justify-between">
            <span className="
              text-[11px] font-semibold tracking-widest text-primary uppercase
            "
            >
              Faltante recuperado
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
            my-1.5 font-display text-[30px] font-semibold tabular-nums
          "
          >
            {money(loss.amount)}
          </div>
          {loss.description && (
            <p className="text-[12.5px] text-muted-foreground">{loss.description}</p>
          )}
        </div>

        {/* Body — scrolls when content exceeds the viewport so the footer stays reachable */}
        <div className="min-h-0 flex-1 overflow-y-auto p-[22px]">
          <h3 className="text-[15px] font-semibold">¿Dónde va esta plata ahora?</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            El faltante se va a revertir y la utilidad va a volver a subir.
          </p>

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
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold">
                      {d.label}
                      {' '}
                      <span className="font-normal text-muted-foreground">
                        {'· '}
                        {d.sub}
                      </span>
                    </div>
                  </div>
                  {selected && (
                    <Check className="size-[18px] shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>

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

          {error && (
            <div className="mt-2 text-xs text-destructive">{error}</div>
          )}
        </div>

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
            Recuperar
            {' '}
            {money(loss.amount)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
