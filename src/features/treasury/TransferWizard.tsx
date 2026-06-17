'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { Check, ChevronRight, Coins, Landmark, Lock, Monitor, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { transferEntreCajas } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cashInputCls, money } from '@/features/cash/cash-ui';

// ── Helpers ──────────────────────────────────────────────────────────────────

function iconForType(type: string): React.ReactNode {
  if (type === 'caja') {
    return <Monitor className="size-[17px]" />;
  }
  if (type === 'caja_fuerte') {
    return <Lock className="size-[17px]" />;
  }
  if (type === 'banco') {
    return <Landmark className="size-[17px]" />;
  }
  return <Coins className="size-[17px]" />;
}

function groupLabel(type: string): string {
  if (type === 'caja') {
    return 'Caja POS';
  }
  if (type === 'caja_fuerte') {
    return 'Caja fuerte';
  }
  if (type === 'banco') {
    return 'Banco';
  }
  return 'Otro';
}

// ── Place picker ─────────────────────────────────────────────────────────────

function PlacePicker({
  accounts,
  value,
  exclude,
  onPick,
}: {
  accounts: TreasuryAccount[];
  value: string;
  exclude: string;
  onPick: (key: string) => void;
}) {
  const eligible = accounts.filter(
    a => a.key !== exclude && (a.type === 'caja_fuerte' || a.type === 'banco' || a.type === 'caja'),
  );

  if (eligible.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay otros contenedores disponibles.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {eligible.map((a) => {
        const selected = value === a.key;
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => onPick(a.key)}
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
                flex size-[34px] shrink-0 items-center justify-center
                rounded-[11px] transition-colors
                ${selected
            ? 'bg-primary text-primary-foreground'
            : `bg-accent text-secondary-foreground`}
              `}
            >
              {iconForType(a.type)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{a.name}</div>
              <div className="text-[12px] text-muted-foreground tabular-nums">
                {money(a.balance)}
                {' '}
                ·
                {' '}
                {groupLabel(a.type)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── TransferWizard ────────────────────────────────────────────────────────────

type TransferWizardProps = {
  accounts: TreasuryAccount[];
  /**
   * Pre-fill the source account key (e.g. when opened from a place's move button).
   * If provided, step 1 is pre-selected and the user starts on step 2.
   */
  initFromKey?: string;
  open: boolean;
  onClose: () => void;
};

const STEP_TITLES = [
  '',
  '¿De dónde sale la plata?',
  '¿A dónde va?',
  '¿Cuánto querés mover?',
  'Confirmá el movimiento',
];

const QUICK_AMOUNTS = [10_000, 25_000, 50_000];

/**
 * Step-by-step modal for transferring money between treasury places.
 * Steps: 1 ¿de dónde? → 2 ¿a dónde? → 3 ¿cuánto? → 4 confirmar.
 * Wired to transferEntreCajas. Opens from TreasuryActions ("Mover dinero")
 * and from each place's move button (pre-fills source via initFromKey).
 */
export function TransferWizard({
  accounts,
  initFromKey,
  open,
  onClose,
}: TransferWizardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const initialStep = initFromKey ? 2 : 1;
  const [step, setStep] = useState(initialStep);
  const [fromKey, setFromKey] = useState(initFromKey ?? '');
  const [toKey, setToKey] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fromAccount = accounts.find(a => a.key === fromKey);
  const toAccount = accounts.find(a => a.key === toKey);

  function reset() {
    const startStep = initFromKey ? 2 : 1;
    setStep(startStep);
    setFromKey(initFromKey ?? '');
    setToKey('');
    setAmount('');
    setReason('');
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  // Step can go back — reset downstream state when going backwards
  function goBack() {
    if (step === 2 && !initFromKey) {
      setToKey('');
      setStep(1);
    } else if (step === 2 && initFromKey) {
      // Opened pre-filled: going back clears "to" but stays on step 2
      setToKey('');
    } else if (step === 3) {
      setAmount('');
      setStep(2);
    } else if (step === 4) {
      setStep(3);
    }
  }

  const nextDisabled
    = (step === 1 && !fromKey)
      || (step === 2 && !toKey)
      || (step === 3 && (!amount || Number(amount) <= 0));

  function submit() {
    setError(null);
    if (!fromAccount || !toAccount) {
      return;
    }
    startTransition(async () => {
      try {
        const res = await transferEntreCajas(
          fromKey,
          toKey,
          amount,
          reason.trim() || null,
        );
        if (!res.ok) {
          setError(res.error);
          return;
        }
        handleClose();
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
          handleClose();
        }
      }}
    >
      <DialogContent className="max-w-[460px] overflow-hidden p-0">
        {/* Header */}
        <div className="border-b border-border px-[22px] py-5">
          <div className="flex items-center justify-between">
            <div className="
              text-[11px] font-semibold tracking-widest text-muted-foreground
              uppercase
            "
            >
              Mover dinero · paso
              {' '}
              {step}
              {' '}
              de 4
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="
                flex size-8 items-center justify-center rounded-[9px] border
                border-border text-muted-foreground transition-colors
                hover:bg-muted hover:text-foreground
              "
            >
              <X className="size-4" />
            </button>
          </div>
          <h3 className="mt-2 text-[15px] font-semibold">{STEP_TITLES[step]}</h3>
          {/* Progress bar */}
          <div className="mt-3.5 flex gap-1.5">
            {[1, 2, 3, 4].map(n => (
              <div
                key={n}
                className={`
                  h-1 flex-1 rounded-full transition-colors
                  ${n <= step ? 'bg-primary' : 'bg-border'}
                `}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-[200px] p-[22px]">
          {step === 1 && (
            <PlacePicker
              accounts={accounts}
              value={fromKey}
              exclude={toKey}
              onPick={(k) => {
                setFromKey(k);
                setError(null);
              }}
            />
          )}

          {step === 2 && (
            <PlacePicker
              accounts={accounts}
              value={toKey}
              exclude={fromKey}
              onPick={(k) => {
                setToKey(k);
                setError(null);
              }}
            />
          )}

          {step === 3 && (
            <div className="flex flex-col items-center pt-3.5 text-center">
              {fromAccount && (
                <div className="mb-2.5 text-[12.5px] text-muted-foreground">
                  Disponible en
                  {' '}
                  <strong>{fromAccount.name}</strong>
                  {': '}
                  <span className="font-semibold tabular-nums">{money(fromAccount.balance)}</span>
                </div>
              )}
              <input
                className={`
                  ${cashInputCls}
                  h-16 text-center font-display text-[30px] font-semibold
                `}
                type="number"
                inputMode="decimal"
                min="0"
                placeholder="$ 0"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                autoFocus
              />
              <div className="mt-3.5 flex flex-wrap justify-center gap-2">
                {QUICK_AMOUNTS.map(q => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setAmount(String(q))}
                    className="
                      h-9 rounded-[8px] border border-input bg-card px-3.5
                      text-[12.5px] font-semibold text-secondary-foreground
                      transition-colors
                      hover:bg-muted
                    "
                  >
                    {money(q)}
                  </button>
                ))}
              </div>
              {/* Optional note */}
              <div className="mt-4 w-full text-left">
                <span className="
                  text-xs font-semibold text-secondary-foreground
                "
                >
                  Nota (opcional)
                </span>
                <input
                  className={`
                    ${cashInputCls}
                    mt-1.5
                  `}
                  placeholder="Ej: para la semana"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
              </div>
            </div>
          )}

          {step === 4 && fromAccount && toAccount && (
            <div className="flex flex-col gap-3.5">
              {/* From → To */}
              <div className="flex items-center gap-3">
                <div className="
                  flex-1 rounded-[12px] border border-border bg-muted p-3.5
                "
                >
                  <div className="
                    text-[11.5px] font-semibold tracking-wide
                    text-muted-foreground uppercase
                  "
                  >
                    Desde
                  </div>
                  <div className="mt-0.5 text-[14px] font-[650]">{fromAccount.name}</div>
                </div>
                <ChevronRight className="size-5 shrink-0 text-primary" />
                <div className="
                  flex-1 rounded-[12px] border border-border bg-muted p-3.5
                "
                >
                  <div className="
                    text-[11.5px] font-semibold tracking-wide
                    text-muted-foreground uppercase
                  "
                  >
                    Hacia
                  </div>
                  <div className="mt-0.5 text-[14px] font-[650]">{toAccount.name}</div>
                </div>
              </div>

              {/* Amount */}
              <div className="
                rounded-[12px] border border-border bg-muted/50 px-4 py-3
                text-center
              "
              >
                <div className="text-[12.5px] text-muted-foreground">Monto a mover</div>
                <div className="
                  mt-0.5 font-display text-[36px] font-semibold tabular-nums
                "
                >
                  {money(Number(amount))}
                </div>
              </div>

              {reason.trim() && (
                <div className="text-[12.5px] text-muted-foreground">
                  <span className="font-semibold">Nota: </span>
                  {reason}
                </div>
              )}

              {error && (
                <div className="text-xs text-destructive">{error}</div>
              )}
            </div>
          )}

          {step !== 4 && error && (
            <div className="mt-3 text-xs text-destructive">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2.5 px-[22px] pb-[22px]">
          {(step > 1 || initFromKey) && step > (initFromKey ? 2 : 1) && (
            <Button
              variant="outline"
              className="h-11 px-[18px]"
              onClick={goBack}
              disabled={isPending}
            >
              Atrás
            </Button>
          )}

          {step < 4
            ? (
                <Button
                  className="h-11 flex-1"
                  disabled={nextDisabled}
                  onClick={() => setStep(s => s + 1)}
                >
                  Siguiente
                </Button>
              )
            : (
                <Button
                  className="h-11 flex-1"
                  disabled={isPending}
                  onClick={submit}
                >
                  <Check className="size-4" />
                  Confirmar movimiento
                </Button>
              )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
