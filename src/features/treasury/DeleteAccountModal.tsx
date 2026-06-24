'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteAccount } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { money } from '@/features/cash/cash-ui';

type DeleteAccountModalProps = {
  /** The account to delete. Null when the modal is closed/idle. */
  account: TreasuryAccount | null;
  open: boolean;
  onClose: () => void;
};

/**
 * Confirmation modal for deleting a caja_fuerte / banco container. Spells out
 * that the balance (if any) moves to "Pendiente de ubicar" and that history is
 * kept. Calls the owner-only deleteAccount action.
 */
export function DeleteAccountModal({ account, open, onClose }: DeleteAccountModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const typeLabel = account?.type === 'banco' ? 'cuenta bancaria' : 'caja fuerte';
  const balance = account?.balance ?? 0;
  const hasBalance = balance > 0;

  function handleClose() {
    setError(null);
    onClose();
  }

  function confirm() {
    const id = account?.accountId;
    if (!id) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await deleteAccount(id);
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

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          handleClose();
        }
      }}
    >
      <DialogContent
        className="max-w-[420px] overflow-hidden p-0"
        showCloseButton={false}
      >
        <div className="p-[22px]">
          <span className="
            flex size-11 items-center justify-center rounded-[12px]
            bg-destructive/10 text-destructive
          "
          >
            <Trash2 className="size-5" />
          </span>
          <h3 className="mt-3.5 text-[16px] font-semibold">
            ¿Eliminar
            {' '}
            {account?.name}
            ?
          </h3>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Vas a eliminar esta
            {' '}
            {typeLabel}
            . No se borra el historial: queda archivada y sus movimientos se
            conservan.
          </p>

          {hasBalance
            ? (
                <div className="
                  mt-3.5 rounded-[12px] border border-warn bg-warn/10 px-4 py-3
                "
                >
                  <div className="text-[12.5px] text-secondary-foreground">
                    El saldo se mueve a
                    {' '}
                    <strong>Pendiente de ubicar</strong>
                    :
                  </div>
                  <div className="
                    mt-0.5 font-display text-[22px] font-semibold tabular-nums
                  "
                  >
                    {money(balance)}
                  </div>
                </div>
              )
            : (
                <p className="mt-3.5 text-[12.5px] text-muted-foreground">
                  No tiene saldo, así que no se mueve plata.
                </p>
              )}

          {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
        </div>

        <div className="flex gap-2.5 border-t border-border px-[22px] py-4">
          <Button
            variant="outline"
            className="h-11 flex-1"
            onClick={handleClose}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            className="h-11 flex-1"
            onClick={confirm}
            disabled={isPending}
          >
            {isPending ? 'Eliminando…' : 'Eliminar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
