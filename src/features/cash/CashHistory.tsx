'use client';

import type { Direction } from './cash-ui';
import type { CajaMovementRow } from '@/actions/cash';
import { useMemo, useState } from 'react';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';
import { dayKey, describeMovement, money, stamp } from './cash-ui';

type DirectionFilter = 'all' | Direction;

// Keep the table short so relevant rows stay above the fold instead of forcing
// a long scroll — page through the rest.
const PAGE_SIZE = 8;

/**
 * Permanent cash ledger browser. Reads the full movement history (every session,
 * never deleted) and filters it client-side by date range, responsable and
 * entrada/salida — using the app's shared styled controls so the table stays
 * dense and uses the full width.
 */
export function CashHistory(props: { movements: CajaMovementRow[] }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [actor, setActor] = useState('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [page, setPage] = useState(0);

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  // Filter options key on the STABLE responsable key (actor id or 'device'), not
  // the frozen createdBy string — so a caja rename never lists its old and new
  // name as two responsables. The label is resolved live server-side.
  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of props.movements) {
      if (!seen.has(m.responsableKey)) {
        seen.set(m.responsableKey, m.responsableLabel);
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [props.movements]);

  const rows = useMemo(() => {
    return props.movements
      .map((m) => {
        const d = describeMovement(m);
        return { m, ...d, amount: Number.parseFloat(m.amount) || 0 };
      })
      .filter((r) => {
        if (direction !== 'all' && r.direction !== direction) {
          return false;
        }
        if (actor !== 'all' && r.m.responsableKey !== actor) {
          return false;
        }
        const key = dayKey(r.m.createdAt);
        if (start && key < start) {
          return false;
        }
        if (end && key > end) {
          return false;
        }
        return true;
      });
  }, [props.movements, direction, actor, start, end]);

  const totals = useMemo(() => {
    let income = 0;
    let outflow = 0;
    for (const r of rows) {
      if (r.direction === 'in') {
        income += r.amount;
      } else {
        outflow += r.amount;
      }
    }
    return { income, outflow, count: rows.length };
  }, [rows]);

  // Clamp against the filtered set so a stale page never shows an empty table.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const hasFilters
    = start !== '' || end !== '' || actor !== 'all' || direction !== 'all';

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setStart(next.start);
    setEnd(next.end);
    setActivePreset(next.preset);
    setPage(0);
  }

  function clearRange() {
    setStart('');
    setEnd('');
    setActivePreset(null);
    setPage(0);
  }

  function clearFilters() {
    clearRange();
    setActor('all');
    setDirection('all');
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      <div className="
        flex flex-col gap-1 border-b border-border px-5 py-3
        sm:flex-row sm:items-center sm:justify-between
      "
      >
        <div>
          <div className="text-sm font-semibold">Historial de caja</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Todos los movimientos quedan registrados de forma permanente.
          </p>
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="
              self-start text-xs font-medium text-primary
              hover:underline
              sm:self-auto
            "
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Filters — styled to match the rest of the app */}
      <div className="
        grid gap-3 border-b border-border bg-muted/30 p-3
        sm:grid-cols-2
        lg:grid-cols-3
      "
      >
        <div className="text-xs">
          <span className="mb-1 block text-muted-foreground">Periodo</span>
          <DateRangePicker
            start={start}
            end={end}
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
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Responsable</span>
          <Select
            value={actor}
            onValueChange={(v) => {
              setActor(v);
              setPage(0);
            }}
            options={[{ value: 'all', label: 'Todos' }, ...actors]}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Movimiento</span>
          <Select
            value={direction}
            onValueChange={(v) => {
              setDirection(v as DirectionFilter);
              setPage(0);
            }}
            options={[
              { value: 'all', label: 'Todos' },
              { value: 'in', label: 'Entradas' },
              { value: 'out', label: 'Salidas' },
            ]}
          />
        </label>
      </div>

      {/* Summary of the filtered set */}
      <div className="
        grid grid-cols-3 divide-x divide-border border-b border-border
        text-center
      "
      >
        <div className="px-3 py-2.5">
          <div className="text-xs text-muted-foreground">Movimientos</div>
          <div className="mt-0.5 font-medium tabular-nums">{totals.count}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-xs text-muted-foreground">Entradas</div>
          <div className="mt-0.5 font-medium text-success tabular-nums">
            {money(totals.income)}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-xs text-muted-foreground">Salidas</div>
          <div className="mt-0.5 font-medium text-destructive tabular-nums">
            {money(totals.outflow)}
          </div>
        </div>
      </div>

      {rows.length === 0
        ? (
            <div className="
              px-5 py-10 text-center text-sm text-muted-foreground
            "
            >
              {props.movements.length === 0
                ? 'Aún no hay movimientos registrados.'
                : 'Ningún movimiento coincide con los filtros.'}
            </div>
          )
        : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="
                    border-b border-border text-left text-xs
                    text-muted-foreground
                  "
                  >
                    <th className="px-5 py-2 font-medium">Fecha</th>
                    <th className="px-3 py-2 font-medium">Tipo</th>
                    <th className="px-3 py-2 font-medium">Concepto</th>
                    <th className="px-3 py-2 font-medium">Responsable</th>
                    <th className="px-5 py-2 text-right font-medium">Monto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageRows.map((r) => {
                    const isIn = r.direction === 'in';
                    return (
                      <tr key={r.m.id}>
                        <td className="
                          px-5 py-2.5 whitespace-nowrap text-muted-foreground
                          tabular-nums
                        "
                        >
                          {stamp(r.m.createdAt)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              `
                                inline-flex items-center gap-1 rounded-full px-2
                                py-0.5 text-xs font-medium
                              `,
                              isIn
                                ? 'bg-success/10 text-success'
                                : 'bg-destructive/10 text-destructive',
                            )}
                          >
                            {isIn ? '↑ Entrada' : '↓ Salida'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{r.title}</div>
                          {r.detail && (
                            <div className="text-xs text-muted-foreground">
                              {r.detail}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {r.m.responsableLabel}
                        </td>
                        <td
                          className={cn(
                            `
                              px-5 py-2.5 text-right font-semibold
                              whitespace-nowrap tabular-nums
                            `,
                            isIn ? 'text-success' : 'text-foreground',
                          )}
                        >
                          {isIn ? '+' : '−'}
                          {money(r.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

      {pageCount > 1 && (
        <div className="
          flex items-center justify-between gap-3 border-t border-border px-5
          py-3
        "
        >
          <div className="text-xs text-muted-foreground tabular-nums">
            {current * PAGE_SIZE + 1}
            –
            {current * PAGE_SIZE + pageRows.length}
            {' de '}
            {rows.length}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={current >= pageCount - 1}
              onClick={() => setPage(current + 1)}
            >
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
