'use client';

import type { InventoryProduct, ProductLot } from '@/actions/inventory';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';
import { getProductLots } from '@/actions/inventory';
import { cn } from '@/utils/Helpers';

function isExpired(lot: ProductLot): boolean {
  return !!lot.expiresAt && new Date(lot.expiresAt) <= new Date();
}

export function ProductLotsDrawer({
  product,
  onClose,
}: {
  product: InventoryProduct;
  onClose: () => void;
}) {
  const [lots, setLots] = useState<ProductLot[] | null>(null);

  useEffect(() => {
    let active = true;
    getProductLots(product.id)
      .then((rows) => {
        if (active) {
          setLots(rows);
        }
      })
      .catch(() => {
        if (active) {
          setLots([]);
        }
      });
    return () => {
      active = false;
    };
  }, [product.id]);

  const dateFmt = new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const totalRemaining = (lots ?? []).reduce((s, l) => s + l.remainingQty, 0);
  const totalValue = (lots ?? []).reduce(
    (s, l) => s + l.remainingQty * (l.unitCost != null ? Number(l.unitCost) : 0),
    0,
  );

  return (
    <DialogPrimitive.Root open onOpenChange={open => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="
            fixed inset-0 z-50 bg-black/50
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            data-[state=open]:animate-in data-[state=open]:fade-in-0
          "
        />
        <DialogPrimitive.Content
          className="
            fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l
            bg-background shadow-lg
            data-[state=closed]:animate-out
            data-[state=closed]:slide-out-to-right
            data-[state=open]:animate-in data-[state=open]:slide-in-from-right
          "
        >
          <div className="flex items-start justify-between border-b p-4">
            <div>
              <DialogPrimitive.Title className="text-lg font-semibold">
                {product.name}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="
                text-sm text-muted-foreground
              "
              >
                Lotes vivos en orden FIFO (el más viejo sale primero)
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="
                rounded-sm text-muted-foreground opacity-70
                hover:opacity-100
              "
              aria-label="Cerrar"
            >
              <XIcon className="size-5" />
            </DialogPrimitive.Close>
          </div>

          <div className="grid grid-cols-2 gap-3 border-b p-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Stock por lotes</div>
              <div className="text-xl font-semibold">{totalRemaining}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Valor (FIFO)</div>
              <div className="text-xl font-semibold text-brand">
                $
                {totalValue.toLocaleString('es-CO')}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {lots === null && (
              <p className="text-sm text-muted-foreground">Cargando lotes...</p>
            )}
            {lots !== null && lots.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Sin lotes registrados en el ledger. El stock proviene de carga
                histórica sin lote.
              </p>
            )}
            <ul className="space-y-3">
              {(lots ?? []).map(l => (
                <li
                  key={l.id}
                  className={cn(
                    'rounded-md border p-3 text-sm',
                    isExpired(l) && 'border-destructive/40 bg-destructive/5',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {l.remainingQty}
                      {' '}
                      /
                      {' '}
                      {l.qty}
                      {' '}
                      u
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      $
                      {l.unitCost ?? '—'}
                      {' '}
                      c/u
                    </span>
                  </div>
                  <div className="
                    mt-1 grid grid-cols-2 gap-1 text-xs text-muted-foreground
                  "
                  >
                    <span>
                      Ingreso:
                      {' '}
                      {dateFmt.format(new Date(l.createdAt))}
                    </span>
                    <span className={cn(isExpired(l) && `
                      font-medium text-destructive
                    `)}
                    >
                      Vence:
                      {' '}
                      {l.expiresAt ? dateFmt.format(new Date(l.expiresAt)) : '—'}
                    </span>
                    <span className="col-span-2">
                      Proveedor:
                      {' '}
                      {l.supplierName ?? '—'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
