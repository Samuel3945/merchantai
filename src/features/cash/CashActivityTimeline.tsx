'use client';

import type { CajaMovementRow } from '@/actions/cash';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/utils/Helpers';
import { dayKey, describeMovement, money } from './cash-ui';

// Chronological activity feed for a single caja — ONLY financial movements,
// newest first, grouped by day. Replaces the old dense table with a scannable
// timeline plus quick chips (todos / ingresos / egresos / ajustes) and a
// reference search. Closures and admin actions live in their own tabs.

type Category = 'income' | 'outflow' | 'adjustment';
type CategoryFilter = 'all' | Category;

const CHIPS: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'income', label: 'Ingresos' },
  { value: 'outflow', label: 'Egresos' },
  { value: 'adjustment', label: 'Ajustes' },
];

// Maps a movement to one of the three timeline buckets. Adjustments
// (manual adjustment / reclassification) are their own bucket so they never
// inflate the ingresos/egresos totals — they are corrections, not operation.
function categoryOf(type: string, direction: 'in' | 'out'): Category {
  if (type === 'adjustment' || type === 'reclassification') {
    return 'adjustment';
  }
  return direction === 'in' ? 'income' : 'outflow';
}

const DOT: Record<Category, string> = {
  income: 'bg-success',
  outflow: 'bg-destructive',
  adjustment: 'bg-amber-500',
};

const todayKey = (): string => dayKey(new Date());

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

const headerFmt = new Intl.DateTimeFormat('es-CO', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

// "Hoy" / "Ayer" / "lunes, 23 de junio de 2026" for the day dividers.
function dayLabel(key: string, sample: Date | string): string {
  if (key === todayKey()) {
    return 'Hoy';
  }
  if (key === yesterdayKey()) {
    return 'Ayer';
  }
  return headerFmt.format(new Date(sample));
}

const timeFmt = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

type Row = {
  m: CajaMovementRow;
  title: string;
  detail: string | null;
  category: Category;
  // The real cash direction drives the +/− sign, independent of the bucket — an
  // adjustment or reclassification can be positive (e.g. "Ajuste +$10.000").
  direction: 'in' | 'out';
  amount: number;
};

export function CashActivityTimeline(props: { movements: CajaMovementRow[] }) {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo<Row[]>(() => {
    return props.movements.map((m) => {
      const d = describeMovement(m);
      return {
        m,
        title: d.title,
        detail: d.detail,
        category: categoryOf(m.type, d.direction),
        direction: d.direction,
        amount: Math.abs(Number.parseFloat(m.amount) || 0),
      };
    });
  }, [props.movements]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (category !== 'all' && r.category !== category) {
        return false;
      }
      if (q) {
        const haystack = `${r.title} ${r.detail ?? ''} ${r.m.reason}`
          .toLowerCase();
        if (!haystack.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, category, query]);

  // Group the (already descending) rows by day, preserving order.
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: Row[] }[] = [];
    for (const r of filtered) {
      const key = dayKey(r.m.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.rows.push(r);
      } else {
        out.push({ key, label: dayLabel(key, r.m.createdAt), rows: [r] });
      }
    }
    return out;
  }, [filtered]);

  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      {/* Quick filters + reference search */}
      <div className="
        flex flex-col gap-3 border-b border-border p-3
        sm:flex-row sm:items-center sm:justify-between
      "
      >
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map(chip => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setCategory(chip.value)}
              className={cn(
                `
                  rounded-full border px-3 py-1 text-xs font-medium
                  transition-colors
                `,
                category === chip.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : `
                    border-border text-muted-foreground
                    hover:text-foreground
                  `,
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="
          relative
          sm:w-56
        "
        >
          <Search className="
            pointer-events-none absolute top-1/2 left-2.5 size-4
            -translate-y-1/2 text-muted-foreground
          "
          />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar por referencia"
            className="
              h-9 w-full rounded-lg border border-input bg-card pr-3 pl-8
              text-sm outline-none
              focus-visible:border-primary focus-visible:ring-2
              focus-visible:ring-ring/30
            "
          />
        </div>
      </div>

      {filtered.length === 0
        ? (
            <div className="
              px-5 py-12 text-center text-sm text-muted-foreground
            "
            >
              {props.movements.length === 0
                ? 'Aún no hay movimientos registrados.'
                : 'Ningún movimiento coincide con el filtro.'}
            </div>
          )
        : (
            // Independent scroll so the tab never grows the whole page.
            <div className="max-h-[60vh] overflow-y-auto">
              {groups.map(group => (
                <section key={group.key}>
                  <div className="
                    sticky top-0 z-10 border-b border-border bg-muted/60 px-5
                    py-1.5 text-xs font-medium text-muted-foreground
                    backdrop-blur-sm
                    first-letter:uppercase
                  "
                  >
                    {group.label}
                  </div>
                  <ul className="divide-y divide-border">
                    {group.rows.map((r) => {
                      const isIn = r.direction === 'in';
                      const isAdj = r.category === 'adjustment';
                      return (
                        <li
                          key={r.m.id}
                          className="flex items-center gap-3 px-5 py-3"
                        >
                          <span
                            className={cn(
                              'size-2.5 shrink-0 rounded-full',
                              DOT[r.category],
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {r.title}
                            </div>
                            {r.detail && (
                              <div className="
                                truncate text-xs text-muted-foreground
                              "
                              >
                                {r.detail}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <div
                              className={cn(
                                'text-sm font-semibold tabular-nums',
                                isAdj
                                  ? 'text-amber-600'
                                  : isIn
                                    ? 'text-success'
                                    : 'text-foreground',
                              )}
                            >
                              {isIn ? '+' : '−'}
                              {money(r.amount)}
                            </div>
                            <div className="
                              text-xs text-muted-foreground tabular-nums
                            "
                            >
                              {timeFmt.format(new Date(r.m.createdAt))}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
    </div>
  );
}
