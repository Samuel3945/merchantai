'use client';

import type {
  AuditFacets,
  AuditLogRow,
  ListAuditLogsResult,
} from '@/actions/audit-log';
import { useCallback, useEffect, useState } from 'react';
import { getAuditFacets, listAuditLogs } from '@/actions/audit-log';
import { exportToCSV } from '@/libs/exports';

const PAGE_SIZE = 50;

const ACTOR_LABEL: Record<AuditLogRow['actorType'], string> = {
  user: 'Admin',
  cashier: 'Cajero',
  system: 'Sistema',
  api: 'API',
};

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
  entityType: string;
};

const EMPTY_FILTERS: Filters = {
  start: '',
  end: '',
  action: '',
  actorId: '',
  entityType: '',
};

function filtersToParams(f: Filters, page: number) {
  return {
    start: f.start || null,
    end: f.end || null,
    action: f.action || null,
    actorId: f.actorId.trim() || null,
    entityType: f.entityType || null,
    page,
    pageSize: PAGE_SIZE,
  };
}

export function AuditTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListAuditLogsResult | null>(null);
  const [facets, setFacets] = useState<AuditFacets>({
    actions: [],
    entityTypes: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const applyFilters = () => {
    setPage(1);
    load(1, filters);
  };

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
    load(1, EMPTY_FILTERS);
  };

  const goPage = (next: number) => {
    const safe = Math.max(1, Math.min(totalPages, next));
    setPage(safe);
    load(safe, filters);
  };

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

      <div className="
        grid gap-3 rounded-md border bg-muted/30 p-3
        md:grid-cols-5
      "
      >
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Desde</span>
          <input
            type="date"
            value={filters.start}
            onChange={e => setFilters({ ...filters, start: e.target.value })}
            className="
              h-9 w-full rounded-md border border-input bg-background px-2
              text-sm
            "
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Hasta</span>
          <input
            type="date"
            value={filters.end}
            onChange={e => setFilters({ ...filters, end: e.target.value })}
            className="
              h-9 w-full rounded-md border border-input bg-background px-2
              text-sm
            "
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Acción</span>
          <select
            value={filters.action}
            onChange={e => setFilters({ ...filters, action: e.target.value })}
            className="
              h-9 w-full rounded-md border border-input bg-background px-2
              text-sm
            "
          >
            <option value="">Todas</option>
            {facets.actions.map(a => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Entidad</span>
          <select
            value={filters.entityType}
            onChange={e =>
              setFilters({ ...filters, entityType: e.target.value })}
            className="
              h-9 w-full rounded-md border border-input bg-background px-2
              text-sm
            "
          >
            <option value="">Todas</option>
            {facets.entityTypes.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Actor (id)</span>
          <input
            type="text"
            value={filters.actorId}
            onChange={e => setFilters({ ...filters, actorId: e.target.value })}
            placeholder="user_…, uuid…"
            className="
              h-9 w-full rounded-md border border-input bg-background px-2
              text-sm
            "
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={applyFilters}
          disabled={loading}
          className="
            h-9 rounded-md bg-foreground px-3 text-sm font-medium
            text-background
            disabled:opacity-50
          "
        >
          Aplicar filtros
        </button>
        <button
          type="button"
          onClick={resetFilters}
          disabled={loading}
          className="
            h-9 rounded-md border border-input bg-background px-3 text-sm
            hover:bg-muted
            disabled:opacity-50
          "
        >
          Limpiar
        </button>
        <div className="grow" />
        <button
          type="button"
          onClick={handleExport}
          disabled={loading || !data || data.items.length === 0}
          className="
            h-9 rounded-md border border-input bg-background px-3 text-sm
            hover:bg-muted
            disabled:opacity-50
          "
        >
          Exportar CSV
        </button>
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
