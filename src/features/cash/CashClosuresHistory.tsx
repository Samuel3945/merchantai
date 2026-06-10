'use client';

import type { CashSession } from '@/libs/cash-helpers';
import { useMemo, useState } from 'react';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Select } from '@/components/ui/select';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';
import { actorLabel, dayKey, money, stamp } from './cash-ui';

type ResultFilter = 'all' | 'diff' | 'square';

/**
 * Permanent closure (arqueo) history. Every closed session is kept forever, so
 * this browses the full record and filters it client-side by date range,
 * responsable and result (con diferencia / cuadradas) using the app's shared
 * styled controls. Mirrors CashHistory but rendered per closed session.
 */
export function CashClosuresHistory(props: { sessions: CashSession[] }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [actor, setActor] = useState('all');
  const [result, setResult] = useState<ResultFilter>('all');

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  const closed = useMemo(
    () => props.sessions.filter(s => s.status === 'closed'),
    [props.sessions],
  );

  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of closed) {
      const id = s.closedBy ?? '';
      if (!seen.has(id)) {
        seen.set(id, id ? actorLabel(id) : '—');
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [closed]);

  const rows = useMemo(() => {
    return closed
      .map((s) => {
        const diff = Number.parseFloat(s.difference ?? '0') || 0;
        return { s, diff };
      })
      .filter((r) => {
        if (result === 'diff' && r.diff === 0) {
          return false;
        }
        if (result === 'square' && r.diff !== 0) {
          return false;
        }
        if (actor !== 'all' && (r.s.closedBy ?? '') !== actor) {
          return false;
        }
        if (!r.s.closedAt) {
          return !start && !end;
        }
        const key = dayKey(r.s.closedAt);
        if (start && key < start) {
          return false;
        }
        if (end && key > end) {
          return false;
        }
        return true;
      });
  }, [closed, result, actor, start, end]);

  const totals = useMemo(() => {
    let surplus = 0;
    let shortage = 0;
    for (const r of rows) {
      if (r.diff > 0) {
        surplus += r.diff;
      } else if (r.diff < 0) {
        shortage += -r.diff;
      }
    }
    return { surplus, shortage, count: rows.length };
  }, [rows]);

  const hasFilters
    = start !== '' || end !== '' || actor !== 'all' || result !== 'all';

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setStart(next.start);
    setEnd(next.end);
    setActivePreset(next.preset);
  }

  function clearRange() {
    setStart('');
    setEnd('');
    setActivePreset(null);
  }

  function clearFilters() {
    clearRange();
    setActor('all');
    setResult('all');
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      <div className="
        flex flex-col gap-1 border-b border-border px-5 py-3
        sm:flex-row sm:items-center sm:justify-between
      "
      >
        <div>
          <div className="text-sm font-semibold">Historial de cierres</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Cada arqueo de caja queda registrado de forma permanente.
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

      {/* Filters — shared styled controls */}
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
            onValueChange={setActor}
            options={[{ value: 'all', label: 'Todos' }, ...actors]}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Resultado</span>
          <Select
            value={result}
            onValueChange={v => setResult(v as ResultFilter)}
            options={[
              { value: 'all', label: 'Todos' },
              { value: 'diff', label: 'Con diferencia' },
              { value: 'square', label: 'Cuadradas' },
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
          <div className="text-xs text-muted-foreground">Cierres</div>
          <div className="mt-0.5 font-medium tabular-nums">{totals.count}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-xs text-muted-foreground">Sobrantes</div>
          <div className="mt-0.5 font-medium text-success tabular-nums">
            {money(totals.surplus)}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-xs text-muted-foreground">Faltantes</div>
          <div className="mt-0.5 font-medium text-destructive tabular-nums">
            {money(totals.shortage)}
          </div>
        </div>
      </div>

      {rows.length === 0
        ? (
            <div className="
              px-5 py-10 text-center text-sm text-muted-foreground
            "
            >
              {closed.length === 0
                ? 'Aún no hay cierres registrados.'
                : 'Ningún cierre coincide con los filtros.'}
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
                    <th className="px-5 py-2 font-medium">Fecha de cierre</th>
                    <th className="px-3 py-2 text-right font-medium">Contado</th>
                    <th className="px-3 py-2 text-right font-medium">Esperado</th>
                    <th className="px-3 py-2 text-right font-medium">Diferencia</th>
                    <th className="px-5 py-2 font-medium">Responsable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => {
                    const sign = r.diff > 0 ? '+' : '';
                    return (
                      <tr key={r.s.id}>
                        <td className="
                          px-5 py-2.5 whitespace-nowrap text-muted-foreground
                          tabular-nums
                        "
                        >
                          {r.s.closedAt ? stamp(r.s.closedAt) : '—'}
                        </td>
                        <td className="
                          px-3 py-2.5 text-right font-medium tabular-nums
                        "
                        >
                          {money(r.s.countedAmount)}
                        </td>
                        <td className="
                          px-3 py-2.5 text-right text-muted-foreground
                          tabular-nums
                        "
                        >
                          {money(r.s.expectedAmount)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right font-semibold tabular-nums',
                            r.diff === 0 && 'text-success',
                            r.diff > 0 && 'text-success',
                            r.diff < 0 && 'text-destructive',
                          )}
                        >
                          {sign}
                          {money(r.diff)}
                        </td>
                        <td className="px-5 py-2.5 text-muted-foreground">
                          {r.s.closedBy ? actorLabel(r.s.closedBy) : '—'}
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
