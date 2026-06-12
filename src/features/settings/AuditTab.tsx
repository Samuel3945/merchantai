'use client';

import type {
  AuditFacets,
  AuditLogRow,
  ListAuditLogsResult,
} from '@/actions/audit-log';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAuditFacets, listAuditLogs } from '@/actions/audit-log';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { exportToCSV } from '@/libs/exports';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';

const PAGE_SIZE = 50;

const ACTOR_LABEL: Record<AuditLogRow['actorType'], string> = {
  user: 'Admin',
  cashier: 'Cajero',
  system: 'Sistema',
  api: 'API',
};

const ACTOR_TYPE_OPTIONS = [
  { value: '', label: 'Todos los tipos' },
  { value: 'user', label: 'Admin' },
  { value: 'cashier', label: 'Cajero' },
  { value: 'system', label: 'Sistema' },
  { value: 'api', label: 'API' },
] as const;

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/Bogota',
});

type Filters = {
  start: string;
  end: string;
  action: string;
  actorId: string;
  actorType: string;
  entityType: string;
};

const EMPTY_FILTERS: Filters = {
  start: '',
  end: '',
  action: '',
  actorId: '',
  actorType: '',
  entityType: '',
};

function filtersToParams(f: Filters, page: number) {
  return {
    start: f.start || null,
    end: f.end || null,
    action: f.action || null,
    actorId: f.actorId.trim() || null,
    actorType: (f.actorType || null) as AuditLogRow['actorType'] | null,
    entityType: f.entityType || null,
    page,
    pageSize: PAGE_SIZE,
  };
}

export function AuditTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListAuditLogsResult | null>(null);
  const [facets, setFacets] = useState<AuditFacets>({
    actions: [],
    entityTypes: [],
    actors: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstRunRef = useRef(true);

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  const load = useCallback(
    async (nextPage = page, nextFilters = filters) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listAuditLogs(filtersToParams(nextFilters, nextPage));
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al cargar auditoría');
      } finally {
        setLoading(false);
      }
    },
    [page, filters],
  );

  useEffect(() => {
    load(1, EMPTY_FILTERS);
    getAuditFacets()
      .then(setFacets)
      .catch(() => null);
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  // Filters auto-apply: any change reloads page 1 — no "apply" button.
  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    setPage(1);
    load(1, filters);
    // eslint-disable-next-line react/exhaustive-deps
  }, [filters]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const resetFilters = () => {
    setActivePreset(null);
    setFilters(EMPTY_FILTERS);
  };

  const goPage = (next: number) => {
    const safe = Math.max(1, Math.min(totalPages, next));
    setPage(safe);
    load(safe, filters);
  };

  const hasActiveFilters = Object.values(filters).some(Boolean);

  const handleExport = async () => {
    try {
      const all = await listAuditLogs({
        ...filtersToParams(filters, 1),
        pageSize: 200,
      });
      const rows = all.items.map(r => ({
        fecha: dateFmt.format(new Date(r.createdAt)),
        actor_tipo: ACTOR_LABEL[r.actorType],
        actor_id: r.actorId,
        accion: r.action,
        entidad: r.entityType,
        entidad_id: r.entityId ?? '',
        ip: r.ip ?? '',
        user_agent: r.userAgent ?? '',
        before: r.before ? JSON.stringify(r.before) : '',
        after: r.after ? JSON.stringify(r.after) : '',
        metadata: JSON.stringify(r.metadata ?? {}),
      }));
      exportToCSV(rows, `auditoria_${new Date().toISOString().slice(0, 10)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al exportar');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Auditoría</h2>
        <p className="text-sm text-muted-foreground">
          Registro de cambios importantes: ventas, devoluciones, ediciones de
          producto, cierres de caja, invitaciones y planes. Solo administradores.
        </p>
      </div>

      {/* Filter bar — same pattern as Ventas/Reportes; filters auto-apply */}
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="
          grid grid-cols-1 gap-3
          sm:grid-cols-2
          lg:grid-cols-5
        "
        >
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Periodo
            </span>
            <DateRangePicker
              start={filters.start}
              end={filters.end}
              compare={false}
              showCompare={false}
              activePreset={activePreset}
              presets={presetOptions}
              maxDate={todayBogota()}
              onApply={(next) => {
                setActivePreset(next.preset);
                setFilters(f => ({ ...f, start: next.start, end: next.end }));
              }}
              onClear={() => {
                setActivePreset(null);
                setFilters(f => ({ ...f, start: '', end: '' }));
              }}
              triggerClassName="w-full"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Acción
            </span>
            <Select
              value={filters.action}
              onValueChange={v => setFilters(f => ({ ...f, action: v }))}
              options={[
                { value: '', label: 'Todas las acciones' },
                ...facets.actions.map(a => ({ value: a, label: a })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Entidad
            </span>
            <Select
              value={filters.entityType}
              onValueChange={v => setFilters(f => ({ ...f, entityType: v }))}
              options={[
                { value: '', label: 'Todas las entidades' },
                ...facets.entityTypes.map(t => ({ value: t, label: t })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Quién
            </span>
            <Select
              value={filters.actorId}
              onValueChange={v => setFilters(f => ({ ...f, actorId: v }))}
              options={[
                { value: '', label: 'Todos los usuarios' },
                ...facets.actors.map(a => ({ value: a.id, label: a.label })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Tipo de actor
            </span>
            <Select
              value={filters.actorType}
              onValueChange={v => setFilters(f => ({ ...f, actorType: v }))}
              options={[...ACTOR_TYPE_OPTIONS]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <Button
                size="sm"
                variant="ghost"
                onClick={resetFilters}
                disabled={loading}
              >
                Limpiar
              </Button>
            )}
            {loading && (
              <span className="text-xs text-muted-foreground">Cargando…</span>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleExport}
            disabled={loading || !data || data.items.length === 0}
          >
            Exportar CSV
          </Button>
        </div>
      </div>

      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="
            bg-muted/40 text-left text-xs text-muted-foreground uppercase
          "
          >
            <tr>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Acción</th>
              <th className="px-3 py-2">Entidad</th>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Cargando…
                </td>
              </tr>
            )}
            {data && data.items.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Sin eventos para los filtros seleccionados.
                </td>
              </tr>
            )}
            {data?.items.map(row => (
              <tr key={row.id} className="border-t">
                <td className="
                  px-3 py-2 text-xs whitespace-nowrap text-muted-foreground
                "
                >
                  {dateFmt.format(new Date(row.createdAt))}
                </td>
                <td className="px-3 py-2">
                  <span className="
                    rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase
                  "
                  >
                    {ACTOR_LABEL[row.actorType]}
                  </span>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground" title={row.actorId}>
                    {row.actorId}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                <td className="px-3 py-2 text-xs">{row.entityType}</td>
                <td
                  className="
                    px-3 py-2 font-mono text-[11px] text-muted-foreground
                  "
                  title={row.entityId ?? ''}
                >
                  {row.entityId ? `${row.entityId.slice(0, 8)}…` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {row.ip ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <div className="
          flex items-center justify-between text-xs text-muted-foreground
        "
        >
          <span>
            Mostrando
            {' '}
            {(page - 1) * PAGE_SIZE + 1}
            –
            {Math.min(page * PAGE_SIZE, data.total)}
            {' '}
            de
            {' '}
            {data.total}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => goPage(page - 1)}
              disabled={page <= 1 || loading}
              className="
                h-8 rounded-sm border border-input bg-background px-2
                hover:bg-muted
                disabled:opacity-50
              "
            >
              Anterior
            </button>
            <span className="flex h-8 items-center px-2">
              {page}
              {' '}
              /
              {' '}
              {totalPages}
            </span>
            <button
              type="button"
              onClick={() => goPage(page + 1)}
              disabled={page >= totalPages || loading}
              className="
                h-8 rounded-sm border border-input bg-background px-2
                hover:bg-muted
                disabled:opacity-50
              "
            >
              Siguiente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
