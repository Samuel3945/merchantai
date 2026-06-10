'use client';

import type { Direction } from './cash-ui';
import type { CashMovement } from '@/libs/cash-helpers';
import { useId, useMemo, useState } from 'react';
import { cn } from '@/utils/Helpers';
import { describeMovement, money } from './cash-ui';

type DirectionFilter = 'all' | Direction;

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'America/Bogota',
});

const stampFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** yyyy-mm-dd in Bogota time — comparable lexicographically with a date input. */
function dayKey(value: Date | string): string {
  return dayKeyFmt.format(new Date(value));
}

function stamp(value: Date | string): string {
  return stampFmt.format(new Date(value));
}

/** Manual movements store a readable name; auto (sale) ones store a Clerk id. */
function actorLabel(createdBy: string): string {
  return createdBy.startsWith('user_') ? 'Sistema' : createdBy;
}

/**
 * Permanent cash ledger browser. Reads the full movement history (every session,
 * never deleted) and filters it client-side by date range, responsable and
 * entrada/salida. Filters use native HTML controls on purpose — zero custom
 * styling, instant, familiar — while the table stays dense to use the full width.
 */
export function CashHistory(props: { movements: CashMovement[] }) {
  const fromId = useId();
  const toId = useId();
  const actorId = useId();
  const dirId = useId();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actor, setActor] = useState('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');

  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of props.movements) {
      if (!seen.has(m.createdBy)) {
        seen.set(m.createdBy, actorLabel(m.createdBy));
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
        if (actor !== 'all' && r.m.createdBy !== actor) {
          return false;
        }
        const key = dayKey(r.m.createdAt);
        if (from && key < from) {
          return false;
        }
        if (to && key > to) {
          return false;
        }
        return true;
      });
  }, [props.movements, direction, actor, from, to]);

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

  const hasFilters
    = from !== '' || to !== '' || actor !== 'all' || direction !== 'all';

  function clearFilters() {
    setFrom('');
    setTo('');
    setActor('all');
    setDirection('all');
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      <div className="
        flex flex-col gap-3 border-b border-border px-5 py-3
        sm:flex-row sm:items-end sm:justify-between
      "
      >
        <div>
          <div className="text-sm font-semibold">Historial de caja</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Todos los movimientos quedan registrados de forma permanente.
          </p>
        </div>

        {/* Native HTML filter controls — default browser styling on purpose */}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-xs">
          <label className="flex flex-col gap-1" htmlFor={fromId}>
            <span className="text-muted-foreground">Desde</span>
            <input
              id={fromId}
              type="date"
              value={from}
              max={to || undefined}
              onChange={e => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={toId}>
            <span className="text-muted-foreground">Hasta</span>
            <input
              id={toId}
              type="date"
              value={to}
              min={from || undefined}
              onChange={e => setTo(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={actorId}>
            <span className="text-muted-foreground">Responsable</span>
            <select
              id={actorId}
              value={actor}
              onChange={e => setActor(e.target.value)}
            >
              <option value="all">Todos</option>
              {actors.map(a => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={dirId}>
            <span className="text-muted-foreground">Movimiento</span>
            <select
              id={dirId}
              value={direction}
              onChange={e => setDirection(e.target.value as DirectionFilter)}
            >
              <option value="all">Todos</option>
              <option value="in">Entradas</option>
              <option value="out">Salidas</option>
            </select>
          </label>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="
                pb-1.5 text-xs font-medium text-primary
                hover:underline
              "
            >
              Limpiar
            </button>
          )}
        </div>
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
                  {rows.map((r) => {
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
                          {actorLabel(r.m.createdBy)}
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
    </div>
  );
}
