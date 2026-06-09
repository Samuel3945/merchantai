'use client';

import type {
  listMovements,
  ListMovementsParams,
  MovementReason,
  MovementType,
} from '@/actions/inventory';
import type { SupplierOption } from '@/features/suppliers/actions';
import { useEffect, useState, useTransition } from 'react';
import { listMovements as fetchMovements } from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { listSuppliersForSelect } from '@/features/suppliers/actions';
import { cn } from '@/utils/Helpers';
import { HISTORY_REASON_OPTIONS, REASON_LABELS } from '../validation';

type MovementRow = Awaited<ReturnType<typeof listMovements>>[number];
type ProductOption = { id: string; name: string };

type Filters = {
  productId: string;
  supplierId: string;
  type: '' | MovementType;
  reason: '' | MovementReason;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = {
  productId: '',
  supplierId: '',
  type: '',
  reason: '',
  from: '',
  to: '',
};

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  entry: { label: 'Entrada', cls: 'bg-success/10 text-success' },
  exit: { label: 'Salida', cls: 'bg-destructive/10 text-destructive' },
  adjustment: { label: 'Ajuste', cls: 'bg-muted text-muted-foreground' },
};

const fieldCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function MovementHistory({ products }: { products: ProductOption[] }) {
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  function doLoad(p: number = 1, override?: Filters) {
    const f = override ?? filters;
    startTransition(async () => {
      const params: ListMovementsParams = { page: p, pageSize: 50 };
      if (f.productId) {
        params.productId = f.productId;
      }
      if (f.supplierId) {
        params.supplierId = f.supplierId;
      }
      if (f.type) {
        params.type = f.type;
      }
      if (f.reason) {
        params.reason = f.reason;
      }
      if (f.from) {
        params.from = f.from;
      }
      if (f.to) {
        params.to = f.to;
      }
      try {
        const rows = await fetchMovements(params);
        setMovements(rows);
        setPage(p);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'No se pudo cargar el historial',
        );
      }
    });
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    doLoad(1, EMPTY_FILTERS);
  }

  useEffect(() => {
    doLoad(1);
    listSuppliersForSelect()
      .then(setSuppliers)
      .catch(() => {});
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  const dateFmt = new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  });

  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="
          grid grid-cols-1 gap-3
          sm:grid-cols-2
          lg:grid-cols-3
        "
        >
          <Field label="Producto">
            <select
              value={filters.productId}
              onChange={e => set('productId', e.target.value)}
              className={fieldCls}
            >
              <option value="">Todos los productos</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Proveedor">
            <select
              value={filters.supplierId}
              onChange={e => set('supplierId', e.target.value)}
              className={fieldCls}
            >
              <option value="">Todos los proveedores</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Tipo de movimiento">
            <select
              value={filters.type}
              onChange={e => set('type', e.target.value as Filters['type'])}
              className={fieldCls}
            >
              <option value="">Entradas y salidas</option>
              <option value="entry">Solo entradas</option>
              <option value="exit">Solo salidas</option>
            </select>
          </Field>

          <Field label="Motivo">
            <select
              value={filters.reason}
              onChange={e => set('reason', e.target.value as Filters['reason'])}
              className={fieldCls}
            >
              <option value="">Todos los motivos</option>
              {HISTORY_REASON_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Desde">
            <input
              type="date"
              value={filters.from}
              onChange={e => set('from', e.target.value)}
              className={fieldCls}
            />
          </Field>

          <Field label="Hasta">
            <input
              type="date"
              value={filters.to}
              onChange={e => set('to', e.target.value)}
              className={fieldCls}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          {hasActiveFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={clearFilters}
              disabled={pending}
            >
              Limpiar
            </Button>
          )}
          <Button size="sm" onClick={() => doLoad(1)} disabled={pending}>
            {pending ? 'Cargando...' : 'Aplicar filtros'}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">Producto</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Cant.</th>
              <th className="px-3 py-2">Motivo</th>
              <th className="px-3 py-2">Quién</th>
              <th className="px-3 py-2 text-right">Costo u.</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {pending ? 'Cargando...' : 'Sin movimientos'}
                    </td>
                  </tr>
                )
              : (
                  movements.map((m) => {
                    const badge = TYPE_BADGE[m.type] ?? TYPE_BADGE.adjustment!;
                    const reasonLabel
                      = REASON_LABELS[m.reason ?? ''] ?? m.reason ?? '—';
                    return (
                      <tr key={m.id} className="border-t align-top">
                        <td className="px-3 py-2 text-xs">
                          {dateFmt.format(new Date(m.createdAt))}
                        </td>
                        <td className="px-3 py-2">
                          {m.currentName ?? m.snapshotName ?? '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              `
                                inline-block rounded-sm px-1.5 py-0.5 text-xs
                                font-medium
                              `,
                              badge.cls,
                            )}
                          >
                            {badge.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {m.type === 'entry' ? '+' : m.type === 'exit' ? '-' : '='}
                          {m.qty}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div>{reasonLabel}</div>
                          {m.notes && (
                            <div className="text-muted-foreground">{m.notes}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {m.createdByName ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {m.unitCost ?? '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
          </tbody>
        </table>
      </div>

      {movements.length >= 50 && (
        <div className="flex gap-2">
          {page > 1 && (
            <Button size="sm" variant="secondary" onClick={() => doLoad(page - 1)}>
              Anterior
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => doLoad(page + 1)}>
            Siguiente
          </Button>
        </div>
      )}
    </div>
  );
}
