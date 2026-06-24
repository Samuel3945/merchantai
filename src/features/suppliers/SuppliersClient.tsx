'use client';

import type {
  Supplier,
  SupplierKpis,
  SupplierListItem,
  SupplierWithProducts,
} from './actions';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/utils/Helpers';
import { listSuppliers, setSupplierStatus } from './actions';
import { SupplierModal } from './SupplierModal';
import { SuppliersImportClient } from './SuppliersImportClient';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value ?? 0;
  return cop.format(Number.isFinite(n as number) ? (n as number) : 0);
}

function formatDate(d: Date | string | null): string {
  if (!d) {
    return '—';
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function StatCard(props: {
  label: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-xs"
      title={props.hint}
    >
      <div className="
        flex items-center gap-1.5 text-xs font-medium text-muted-foreground
      "
      >
        {props.label}
        {props.hint && (
          <span
            className="
              inline-flex size-3.5 items-center justify-center rounded-full
              border border-border text-[9px] text-muted-foreground
            "
            aria-hidden
          >
            ?
          </span>
        )}
      </div>
      <div
        className={cn(
          'mt-1.5 font-display text-xl font-medium tracking-tight tabular-nums',
          props.muted && 'text-muted-foreground',
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Supplier['status'] }) {
  const active = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        active
          ? 'bg-success/10 text-success'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {active ? 'Activo' : 'Archivado'}
    </span>
  );
}

export function SuppliersClient(props: {
  initial: SupplierListItem[];
  kpis: SupplierKpis;
}) {
  const [rows, setRows] = useState<SupplierListItem[]>(props.initial);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<SupplierListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reload() {
    startTransition(async () => {
      const data = await listSuppliers({ search });
      setRows(data);
    });
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => {
      startTransition(async () => {
        const data = await listSuppliers({ search });
        setRows(data);
      });
    }, 250);
    return () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [search]);

  function openCreate() {
    setEditing(null);
    setError(null);
    setOpen(true);
  }

  function openEdit(s: SupplierListItem) {
    setEditing(s);
    setError(null);
    setOpen(true);
  }

  function onSaved(saved: SupplierWithProducts) {
    setRows((prev) => {
      const enriched: SupplierListItem = {
        ...saved,
        // Preserve derived payment data when editing; new rows have none yet.
        totalPaid: prev.find(r => r.id === saved.id)?.totalPaid ?? '0',
        lastPaymentAt: prev.find(r => r.id === saved.id)?.lastPaymentAt ?? null,
      };
      const exists = prev.some(r => r.id === saved.id);
      const next = exists
        ? prev.map(r => (r.id === saved.id ? enriched : r))
        : [enriched, ...prev];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    setOpen(false);
    setEditing(null);
  }

  function onToggleArchive(s: SupplierListItem) {
    const next = s.status === 'active' ? 'archived' : 'active';
    startTransition(async () => {
      try {
        const updated = await setSupplierStatus(s.id, next);
        setRows(prev =>
          prev.map(r => (r.id === updated.id ? { ...r, status: updated.status } : r)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  const hasAny = props.initial.length > 0;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="
        grid grid-cols-2 gap-3
        lg:grid-cols-4
      "
      >
        <StatCard label="Total proveedores" value={String(props.kpis.total)} />
        <StatCard label="Proveedores activos" value={String(props.kpis.active)} />
        <StatCard
          label="Pagos pendientes"
          value={money(props.kpis.pendingPayments)}
        />
        <StatCard
          label="Monto pagado este mes"
          value={money(props.kpis.paidThisMonth)}
        />
      </div>

      {error && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {!hasAny
        ? (
            <div className="
              flex flex-col items-center justify-center rounded-xl border
              border-dashed border-border bg-card px-6 py-16 text-center
            "
            >
              <div className="text-5xl">📦</div>
              <div className="mt-4 text-lg font-semibold">
                Aún no tienes proveedores registrados
              </div>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Agrega tu primer proveedor para registrar compras y pagos.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button onClick={openCreate}>Crear proveedor</Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  Importar proveedores
                </Button>
              </div>
            </div>
          )
        : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por nombre, correo, teléfono o ciudad"
                  className={cn(inputCls, 'max-w-md')}
                />
                <Button onClick={openCreate}>Nuevo proveedor</Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  Importar
                </Button>
                <div className="ml-auto text-sm text-muted-foreground">
                  {rows.length}
                  {' '}
                  proveedor
                  {rows.length === 1 ? '' : 'es'}
                </div>
              </div>

              <div className="overflow-x-auto rounded-md border bg-background">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase">
                    <tr>
                      <th className="px-3 py-2">Nombre</th>
                      <th className="px-3 py-2">Teléfono</th>
                      <th className="px-3 py-2">Correo</th>
                      <th className="px-3 py-2">Productos</th>
                      <th className="px-3 py-2">Estado</th>
                      <th className="px-3 py-2">Último pago</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? (
                          <tr>
                            <td
                              colSpan={7}
                              className="
                                px-3 py-8 text-center text-muted-foreground
                              "
                            >
                              {pending ? 'Cargando…' : 'No se encontraron proveedores'}
                            </td>
                          </tr>
                        )
                      : (
                          rows.map(s => (
                            <tr key={s.id} className="border-t">
                              <td className="px-3 py-2 font-medium">{s.name}</td>
                              <td className="px-3 py-2 font-mono text-xs">
                                {s.phone ?? '—'}
                              </td>
                              <td className="px-3 py-2">{s.email ?? '—'}</td>
                              <td className="px-3 py-2">
                                {s.products.length === 0
                                  ? <span className="text-muted-foreground">—</span>
                                  : (
                                      <span title={s.products.map(p => p.name).join(', ')}>
                                        {s.products.length === 1
                                          ? s.products[0]!.name
                                          : `${s.products.length} productos`}
                                      </span>
                                    )}
                              </td>
                              <td className="px-3 py-2">
                                <StatusBadge status={s.status} />
                              </td>
                              <td className="px-3 py-2">
                                {formatDate(s.lastPaymentAt)}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div className="flex justify-end gap-2">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => openEdit(s)}
                                  >
                                    Editar
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => onToggleArchive(s)}
                                  >
                                    {s.status === 'active' ? 'Archivar' : 'Restaurar'}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                  </tbody>
                </table>
              </div>
            </>
          )}

      {open && (
        <SupplierModal
          editing={editing}
          onClose={() => {
            setOpen(false);
            setEditing(null);
          }}
          onSaved={onSaved}
        />
      )}

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="
          max-h-[85vh] w-[95vw] max-w-5xl overflow-y-auto
        "
        >
          <DialogHeader>
            <DialogTitle>Importar proveedores</DialogTitle>
            <DialogDescription>
              Subí un CSV, Excel, foto o PDF; revisá y corregí cada fila antes de
              cargar tus proveedores.
            </DialogDescription>
          </DialogHeader>
          <SuppliersImportClient onImported={reload} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
