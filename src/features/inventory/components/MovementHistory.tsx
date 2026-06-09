'use client';

import type {
  listMovements,
  ListMovementsParams,
  MovementActor,
  MovementReason,
  MovementType,
} from '@/actions/inventory';
import type { SupplierOption } from '@/features/suppliers/actions';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  listMovements as fetchMovements,
  listMovementActors,
} from '@/actions/inventory';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { listSuppliersForSelect } from '@/features/suppliers/actions';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';
import {
  HISTORY_ENTRY_REASONS,
  HISTORY_EXIT_REASONS,
  HISTORY_REASON_OPTIONS,
  REASON_LABELS,
} from '../validation';

type MovementRow = Awaited<ReturnType<typeof listMovements>>[number];
type ProductOption = { id: string; name: string };

type Filters = {
  productId: string;
  supplierId: string;
  type: '' | MovementType;
  reason: '' | MovementReason;
  createdBy: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = {
  productId: '',
  supplierId: '',
  type: '',
  reason: '',
  createdBy: '',
  from: '',
  to: '',
};

// Above this many suppliers a plain dropdown is painful to scan, so the supplier
// filter becomes a searchable autocomplete (the product filter always is).
const SUPPLIER_AUTOCOMPLETE_THRESHOLD = 30;

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  entry: { label: 'Entrada', cls: 'bg-success/10 text-success' },
  exit: { label: 'Salida', cls: 'bg-destructive/10 text-destructive' },
  adjustment: { label: 'Ajuste', cls: 'bg-muted text-muted-foreground' },
};

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
  const [actors, setActors] = useState<MovementActor[]>([]);
  const [page, setPage] = useState(1);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [pending, startTransition] = useTransition();

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  // Reason options follow the selected movement type (entry / exit / both).
  const reasonOptions = useMemo(() => {
    const base
      = filters.type === 'entry'
        ? HISTORY_ENTRY_REASONS
        : filters.type === 'exit'
          ? HISTORY_EXIT_REASONS
          : HISTORY_REASON_OPTIONS;
    return [
      { value: '', label: 'Todos los motivos' },
      ...base.map(o => ({ value: o.value, label: o.label })),
    ];
  }, [filters.type]);

  // Narrowing the type narrows the reason list, so drop a now-invalid reason.
  function setType(value: Filters['type']) {
    setFilters((prev) => {
      const valid
        = value === 'entry'
          ? HISTORY_ENTRY_REASONS
          : value === 'exit'
            ? HISTORY_EXIT_REASONS
            : HISTORY_REASON_OPTIONS;
      const keepReason
        = prev.reason === '' || valid.some(r => r.value === prev.reason);
      return { ...prev, type: value, reason: keepReason ? prev.reason : '' };
    });
  }

  const supplierAutocomplete
    = suppliers.length > SUPPLIER_AUTOCOMPLETE_THRESHOLD;
  const advancedCount = [filters.reason, filters.createdBy].filter(Boolean).length;

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
      if (f.createdBy) {
        params.createdBy = f.createdBy;
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

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    const merged = { ...filters, from: next.start, to: next.end };
    setFilters(merged);
    setActivePreset(next.preset);
    doLoad(1, merged);
  }

  function clearRange() {
    const merged = { ...filters, from: '', to: '' };
    setFilters(merged);
    setActivePreset(null);
    doLoad(1, merged);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setActivePreset(null);
    doLoad(1, EMPTY_FILTERS);
  }

  useEffect(() => {
    doLoad(1);
    listSuppliersForSelect()
      .then(setSuppliers)
      .catch(() => {});
    listMovementActors()
      .then(setActors)
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
          lg:grid-cols-4
        "
        >
          <Field label="Producto">
            <Combobox
              value={filters.productId}
              onValueChange={v => set('productId', v)}
              placeholder="Todos los productos"
              searchPlaceholder="Buscar producto..."
              emptyText="Sin productos"
              options={[
                { value: '', label: 'Todos los productos' },
                ...products.map(p => ({ value: p.id, label: p.name })),
              ]}
            />
          </Field>

          <Field label="Proveedor">
            {supplierAutocomplete
              ? (
                  <Combobox
                    value={filters.supplierId}
                    onValueChange={v => set('supplierId', v)}
                    placeholder="Todos los proveedores"
                    searchPlaceholder="Buscar proveedor..."
                    emptyText="Sin proveedores"
                    options={[
                      { value: '', label: 'Todos los proveedores' },
                      ...suppliers.map(s => ({ value: s.id, label: s.name })),
                    ]}
                  />
                )
              : (
                  <Select
                    value={filters.supplierId}
                    onValueChange={v => set('supplierId', v)}
                    options={[
                      { value: '', label: 'Todos los proveedores' },
                      ...suppliers.map(s => ({ value: s.id, label: s.name })),
                    ]}
                  />
                )}
          </Field>

          <Field label="Tipo de movimiento">
            <Select
              value={filters.type}
              onValueChange={v => setType(v as Filters['type'])}
              options={[
                { value: '', label: 'Entradas y salidas' },
                { value: 'entry', label: 'Solo entradas' },
                { value: 'exit', label: 'Solo salidas' },
              ]}
            />
          </Field>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Periodo
            </span>
            <DateRangePicker
              start={filters.from}
              end={filters.to}
              compare={false}
              showCompare={false}
              activePreset={activePreset}
              presets={presetOptions}
              maxDate={todayBogota()}
              onApply={applyRange}
              onClear={clearRange}
              triggerClassName="w-full"
            />
          </div>
        </div>

        {showMore && (
          <div className="
            grid grid-cols-1 gap-3 border-t pt-3
            sm:grid-cols-2
            lg:grid-cols-4
          "
          >
            <Field label="Motivo">
              <Select
                value={filters.reason}
                onValueChange={v => set('reason', v as Filters['reason'])}
                options={reasonOptions}
              />
            </Field>

            <Field label="Usuario que realizó el movimiento">
              <Select
                value={filters.createdBy}
                onValueChange={v => set('createdBy', v)}
                options={[
                  { value: '', label: 'Todos los usuarios' },
                  ...actors.map(a => ({ value: a.id, label: a.name })),
                ]}
              />
            </Field>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowMore(v => !v)}
            disabled={pending}
          >
            {showMore
              ? 'Menos filtros'
              : `Más filtros${advancedCount > 0 ? ` (${advancedCount})` : ''}`}
          </Button>
          <div className="flex items-center gap-2">
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
