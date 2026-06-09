'use client';

import type { InventoryProduct } from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { STATUS_CONFIG } from '../validation';
import { MinStockCell } from './MinStockCell';

export function StockTable({
  products,
  pending,
  onEntry,
  onExit,
  onRowClick,
  onMinSaved,
}: {
  products: InventoryProduct[];
  pending: boolean;
  onEntry: (p: InventoryProduct) => void;
  onExit: (p: InventoryProduct) => void;
  onRowClick: (p: InventoryProduct) => void;
  onMinSaved: () => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border bg-background">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase">
          <tr>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Producto</th>
            <th className="px-3 py-2">Categoría</th>
            <th className="px-3 py-2 text-right">Stock</th>
            <th className="px-3 py-2 text-right">Min</th>
            <th className="px-3 py-2 text-right">Max rec.</th>
            <th className="px-3 py-2">Unidad</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {products.length === 0
            ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {pending ? 'Cargando...' : 'Sin productos'}
                  </td>
                </tr>
              )
            : (
                products.map((p) => {
                  const status = STATUS_CONFIG[p.status];
                  return (
                    <tr
                      key={p.id}
                      onClick={() => onRowClick(p)}
                      className="
                        cursor-pointer border-t
                        hover:bg-accent/50
                      "
                    >
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-block size-2.5 rounded-full',
                              status.dot,
                            )}
                          />
                          <span className={cn('text-xs', status.text)}>
                            {status.label}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2 text-xs">{p.category ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.stock}</td>
                      <td className="px-3 py-2 text-right">
                        <MinStockCell product={p} onSaved={onMinSaved} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {p.stockMaxRecommended ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">{p.unitType}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEntry(p);
                            }}
                          >
                            Entrada
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              onExit(p);
                            }}
                          >
                            Salida
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
        </tbody>
      </table>
    </div>
  );
}
