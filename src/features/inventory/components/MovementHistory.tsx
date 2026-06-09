'use client';

import type { listMovements, ListMovementsParams } from '@/actions/inventory';
import { useEffect, useState, useTransition } from 'react';
import { listMovements as fetchMovements } from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import { REASON_LABELS } from '../validation';

type MovementRow = Awaited<ReturnType<typeof listMovements>>[number];

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  entry: { label: 'Entrada', cls: 'bg-success/10 text-success' },
  exit: { label: 'Salida', cls: 'bg-destructive/10 text-destructive' },
  adjustment: { label: 'Ajuste', cls: 'bg-muted text-muted-foreground' },
};

export function MovementHistory() {
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();

  function doLoad(p: number = 1) {
    startTransition(async () => {
      const params: ListMovementsParams = { page: p, pageSize: 50 };
      if (from) {
        params.from = from;
      }
      if (to) {
        params.to = to;
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

  useEffect(() => {
    doLoad(1);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Desde</label>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="
              flex h-9 w-40 rounded-md border border-input bg-transparent px-3
              py-1 text-sm shadow-xs outline-none
              focus-visible:ring-2 focus-visible:ring-ring/50
            "
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Hasta</label>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="
              flex h-9 w-40 rounded-md border border-input bg-transparent px-3
              py-1 text-sm shadow-xs outline-none
              focus-visible:ring-2 focus-visible:ring-ring/50
            "
          />
        </div>
        <div className="flex items-end">
          <Button size="sm" onClick={() => doLoad(1)} disabled={pending}>
            {pending ? 'Cargando...' : 'Filtrar'}
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
