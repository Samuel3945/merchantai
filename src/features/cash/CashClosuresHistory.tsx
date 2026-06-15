'use client';

import type { CashSession } from '@/libs/cash-helpers';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { recordCashCorrection } from '@/actions/cash';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';
import { actorLabel, cashInputCls, dayKey, money, stamp } from './cash-ui';

type ResultFilter = 'all' | 'diff' | 'square';

// Keep the table short so relevant closures stay above the fold; page the rest.
const PAGE_SIZE = 8;

const OTHER_MOTIVO = '__otro__';

// Common reasons a closed session ends off, by the direction the owner records.
// 'in' raises the drawer (money that came in and was missed); 'out' lowers it
// (money that went out and was missed). Most-common first.
const IN_MOTIVOS = [
  {
    value: 'Olvidé registrar una venta o ingreso en efectivo',
    label: 'Olvidé registrar una venta o ingreso en efectivo',
  },
  {
    value: 'Apareció dinero que no había contado',
    label: 'Apareció dinero que no había contado',
  },
  {
    value: 'Registré un pago que en realidad no se hizo',
    label: 'Registré un pago que en realidad no se hizo',
  },
  { value: OTHER_MOTIVO, label: 'Otro (especificar)' },
];

const OUT_MOTIVOS = [
  {
    value: 'Pagué un gasto en efectivo y no lo registré',
    label: 'Pagué un gasto en efectivo y no lo registré',
  },
  {
    value: 'Di mal el vuelto / error a favor del cliente',
    label: 'Di mal el vuelto / error a favor del cliente',
  },
  { value: OTHER_MOTIVO, label: 'Otro (especificar)' },
];

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
  const [page, setPage] = useState(0);

  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The closed session being corrected, plus the correction form fields. The
  // owner picks the direction and reason — the system never infers them.
  const [correctId, setCorrectId] = useState<string | null>(null);
  const [correctDir, setCorrectDir] = useState<'in' | 'out'>('in');
  const [correctMotivo, setCorrectMotivo] = useState('');
  const [correctOther, setCorrectOther] = useState('');
  const [correctAmount, setCorrectAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const motivos = correctDir === 'in' ? IN_MOTIVOS : OUT_MOTIVOS;
  const needsOther = correctMotivo === OTHER_MOTIVO;
  const correctReady
    = correctAmount !== ''
      && correctMotivo !== ''
      && (!needsOther || correctOther.trim() !== '');

  function openCorrect(sessionId: string, diff: number) {
    setError(null);
    setCorrectId(sessionId);
    // Suggest the direction that explains the sign (short → an unrecorded
    // outflow; surplus → an unrecorded income), but the owner can flip it.
    setCorrectDir(diff < 0 ? 'out' : 'in');
    setCorrectMotivo('');
    setCorrectOther('');
    setCorrectAmount(diff !== 0 ? String(Math.abs(diff)) : '');
  }

  function pickDir(dir: 'in' | 'out') {
    setCorrectDir(dir);
    setCorrectMotivo('');
    setCorrectOther('');
  }

  function submitCorrection() {
    if (!correctId) {
      return;
    }
    const reason = needsOther ? correctOther.trim() : correctMotivo;
    setError(null);
    startTransition(async () => {
      try {
        const res = await recordCashCorrection(
          correctId,
          correctDir,
          correctAmount,
          reason,
        );
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setCorrectId(null);
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

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

  // Clamp against the filtered set so a stale page never shows an empty table.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const hasFilters
    = start !== '' || end !== '' || actor !== 'all' || result !== 'all';

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
            onValueChange={(v) => {
              setActor(v);
              setPage(0);
            }}
            options={[{ value: 'all', label: 'Todos' }, ...actors]}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Resultado</span>
          <Select
            value={result}
            onValueChange={(v) => {
              setResult(v as ResultFilter);
              setPage(0);
            }}
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
                  {pageRows.map((r) => {
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
                          <div className="
                            flex items-center justify-between gap-2
                          "
                          >
                            <span>
                              {r.s.closedBy ? actorLabel(r.s.closedBy) : '—'}
                            </span>
                            {r.diff !== 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openCorrect(r.s.id, r.diff)}
                              >
                                Corregir
                              </Button>
                            )}
                          </div>
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

      {correctId && (
        <div className="
          fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
        "
        >
          <div className="
            w-full max-w-md rounded-xl border border-border bg-card p-5
            shadow-lg
          "
          >
            <div className="text-sm font-semibold">Corregir cierre</div>
            <p className="mt-1 text-xs text-muted-foreground">
              El cierre original no se modifica. Registrás el movimiento que se
              olvidó, ligado a este cierre. Vos elegís si entró o salió plata.
            </p>
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => pickDir('in')}
                  className={cn(
                    `
                      rounded-lg border px-3 py-2 text-sm font-medium
                      transition-colors
                    `,
                    correctDir === 'in'
                      ? 'border-success bg-success/10 text-success'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  Entró plata
                </button>
                <button
                  type="button"
                  onClick={() => pickDir('out')}
                  className={cn(
                    `
                      rounded-lg border px-3 py-2 text-sm font-medium
                      transition-colors
                    `,
                    correctDir === 'out'
                      ? 'border-destructive bg-destructive/10 text-destructive'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  Salió plata
                </button>
              </div>

              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Motivo</span>
                <Select
                  value={correctMotivo}
                  onValueChange={setCorrectMotivo}
                  options={motivos}
                  placeholder="Elegí un motivo"
                />
              </label>

              {needsOther && (
                <input
                  className={cashInputCls}
                  placeholder="Descripción (obligatoria)"
                  value={correctOther}
                  onChange={e => setCorrectOther(e.target.value)}
                />
              )}

              <div>
                <label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="correct-amount"
                >
                  Monto
                </label>
                <input
                  id="correct-amount"
                  className={cashInputCls}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={correctAmount}
                  onChange={e => setCorrectAmount(e.target.value)}
                />
              </div>

              {error && <div className="text-sm text-destructive">{error}</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => setCorrectId(null)}
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={pending || !correctReady}
                onClick={submitCorrection}
              >
                Registrar corrección
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
