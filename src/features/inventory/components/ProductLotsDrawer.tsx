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

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('es-CO')}`;
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
    month: 'long',
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
            <div className="pr-4">
              <DialogPrimitive.Title className="text-lg font-semibold">
                {product.name}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="
                text-sm text-muted-foreground
              "
              >
                Cada tarjeta es una compra o ingreso de este producto. Al
                vender, primero salen los más antiguos para que no se te venza
                nada.
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
              <div className="text-xs text-muted-foreground">
                Unidades disponibles
              </div>
              <div className="text-xl font-semibold">{totalRemaining}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                Cuánto vale tu stock
              </div>
              <div className="text-xl font-semibold text-brand">
                {money(totalValue)}
              </div>
              <div className="text-xs text-muted-foreground">a precio de costo</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {lots === null && (
              <p className="text-sm text-muted-foreground">Cargando...</p>
            )}
            {lots !== null && lots.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Todavía no hay compras registradas para este producto. El stock
                actual viene de una carga inicial.
              </p>
            )}
            <ul className="space-y-3">
              {(lots ?? []).map((l) => {
                const expired = isExpired(l);
                return (
                  <li
                    key={l.id}
                    className={cn(
                      'rounded-md border p-3 text-sm',
                      expired && 'border-destructive/40 bg-destructive/5',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        Ingresó el
                        {' '}
                        {dateFmt.format(new Date(l.createdAt))}
                      </span>
                      {expired && (
                        <span className="
                          rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs
                          font-medium text-destructive
                        "
                        >
                          Vencido
                        </span>
                      )}
                    </div>
                    <div className="mt-2 space-y-1 text-muted-foreground">
                      <p>
                        <span className="text-foreground">
                          Quedan
                          {' '}
                          {l.remainingQty}
                          {' '}
                          de
                          {' '}
                          {l.qty}
                          {' '}
                          unidades
                        </span>
                      </p>
                      <p>
                        Costo:
                        {' '}
                        {l.unitCost != null ? money(Number(l.unitCost)) : 'sin registrar'}
                        {' '}
                        por unidad
                      </p>
                      <p>
                        Proveedor:
                        {' '}
                        {l.supplierName ?? 'sin registrar'}
                      </p>
                      <p className={cn(expired && 'font-medium text-destructive')}>
                        {l.expiresAt
                          ? `Se vence el ${dateFmt.format(new Date(l.expiresAt))}`
                          : 'Sin fecha de vencimiento'}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
