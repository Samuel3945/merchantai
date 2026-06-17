'use client';

import type { PaymentMethodRow } from '@/actions/payment-methods';
import { Landmark, Lock, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, useTransition } from 'react';
import { createBanco, createCajaFuerte } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from '@/features/cash/cash-ui';

type AccountType = 'fuerte' | 'banco';

type CreateSlideoverProps = {
  open: boolean;
  onClose: () => void;
  /**
   * Active payment methods of type 'transfer' — used to let the user pick
   * a linked payment method when creating a bank account.
   */
  transferMethods: PaymentMethodRow[];
};

/**
 * Right-side slide-over panel to create a new treasury place.
 * Type toggle: Caja fuerte | Banco.
 * Caja fuerte → createCajaFuerte(name, openingBalance).
 * Banco → createBanco(name, paymentMethodId, openingBalance).
 */
export function CreateSlideover({
  open,
  onClose,
  transferMethods,
}: CreateSlideoverProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [type, setType] = useState<AccountType>('fuerte');
  const [name, setName] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setType('fuerte');
    setName('');
    setPaymentMethodId('');
    setOpeningBalance('');
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError('Ingresá un nombre');
      return;
    }
    if (type === 'banco' && !paymentMethodId) {
      setError('Seleccioná el método de pago vinculado');
      return;
    }
    const bal = Number.parseFloat(openingBalance) || 0;

    startTransition(async () => {
      try {
        let res;
        if (type === 'banco') {
          res = await createBanco(name.trim(), paymentMethodId, bal);
        } else {
          res = await createCajaFuerte(name.trim(), bal);
        }
        if (!res.ok) {
          setError(res.error);
          return;
        }
        handleClose();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  const typeOptions: { k: AccountType; label: string }[] = [
    { k: 'fuerte', label: 'Caja fuerte' },
    { k: 'banco', label: 'Banco' },
  ];

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          handleClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay
          className="
            fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            data-[state=open]:animate-in data-[state=open]:fade-in-0
          "
        />

        {/* Slide-in panel (right side) */}
        <DialogPrimitive.Content
          className="
            fixed top-0 right-0 z-50 flex size-full max-w-[400px] flex-col
            border-l border-border bg-card shadow-xl duration-200
            data-[state=closed]:animate-out
            data-[state=closed]:slide-out-to-right
            data-[state=open]:animate-in data-[state=open]:slide-in-from-right
          "
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="
            flex items-start justify-between gap-4 border-b border-border
            px-[22px] py-5
          "
          >
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold">
                Agregar lugar
              </DialogPrimitive.Title>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Un nuevo sitio donde guardás plata.
              </p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="
                flex size-8 shrink-0 items-center justify-center rounded-[9px]
                border border-border text-muted-foreground transition-colors
                hover:bg-muted hover:text-foreground
              "
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Body */}
          <div className="
            flex flex-1 flex-col gap-[18px] overflow-y-auto p-[22px]
          "
          >
            {/* Type toggle */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-secondary-foreground">
                Tipo de lugar
              </span>
              <div className="flex gap-1 rounded-[10px] bg-muted p-[3px]">
                {typeOptions.map(o => (
                  <button
                    key={o.k}
                    type="button"
                    onClick={() => {
                      setType(o.k);
                      setPaymentMethodId('');
                      setError(null);
                    }}
                    className={`
                      flex flex-1 items-center justify-center gap-2
                      rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-semibold
                      transition-[background-color,color]
                      ${type === o.k
                    ? 'bg-card text-foreground shadow-sm'
                    : `
                      text-muted-foreground
                      hover:text-secondary-foreground
                    `}
                    `}
                  >
                    {o.k === 'fuerte'
                      ? <Lock className="size-3.5" />
                      : <Landmark className="size-3.5" />}
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-secondary-foreground">
                Nombre
              </span>
              <input
                className={cashInputCls}
                placeholder={type === 'banco' ? 'Ej: Nequi' : 'Ej: Cajón de la Cocina'}
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </div>

            {/* Payment method picker for banco */}
            {type === 'banco' && (
              <div className="flex flex-col gap-1.5">
                <span className="
                  text-xs font-semibold text-secondary-foreground
                "
                >
                  Método de pago vinculado
                </span>
                {transferMethods.length > 0
                  ? (
                      <Select
                        value={paymentMethodId}
                        onValueChange={setPaymentMethodId}
                        options={transferMethods.map(m => ({ value: m.id, label: m.name }))}
                        placeholder="Seleccioná el método de transferencia"
                      />
                    )
                  : (
                      <p className="text-xs text-muted-foreground">
                        No hay métodos de pago de tipo transferencia configurados.
                        Agregá uno en Configuración → Métodos de pago.
                      </p>
                    )}
              </div>
            )}

            {/* Opening balance */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-secondary-foreground">
                Saldo actual
              </span>
              <input
                className={cashInputCls}
                type="number"
                inputMode="decimal"
                min="0"
                placeholder="$ 0"
                value={openingBalance}
                onChange={e => setOpeningBalance(e.target.value)}
              />
            </div>

            {error && (
              <div className="text-xs text-destructive">{error}</div>
            )}
          </div>

          {/* Footer */}
          <div className="flex gap-2.5 border-t border-border p-[22px]">
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={handleClose}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button
              className="h-11 flex-1"
              disabled={isPending || !name.trim() || (type === 'banco' && !paymentMethodId && transferMethods.length > 0)}
              onClick={submit}
            >
              Crear
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
