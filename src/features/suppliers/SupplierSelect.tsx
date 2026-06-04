'use client';

import type { SupplierOption } from './actions';
import { useMemo, useState } from 'react';

const inputCls
  = 'flex h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30';

/**
 * Searchable supplier picker. Presentational: the parent owns the option list
 * (so a freshly created supplier can be injected and auto-selected) and the
 * quick-create trigger. Filtering is client-side — a single business has few
 * suppliers, so a round-trip per keystroke would be wasteful.
 */
export function SupplierSelect(props: {
  options: SupplierOption[];
  value: SupplierOption | null;
  loading?: boolean;
  onChange: (supplier: SupplierOption | null) => void;
  onQuickCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = props.options;
    if (!q) {
      return base.slice(0, 50);
    }
    return base
      .filter(
        o =>
          o.name.toLowerCase().includes(q)
          || (o.company ?? '').toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [query, props.options]);

  if (props.value) {
    return (
      <div className="
        flex items-center justify-between gap-2 rounded-lg border
        border-primary/40 bg-primary/5 px-3 py-2.5
      "
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.value.name}</div>
          {props.value.company && (
            <div className="truncate text-xs text-muted-foreground">
              {props.value.company}
            </div>
          )}
        </div>
        <button
          type="button"
          className="
            shrink-0 text-xs font-medium text-muted-foreground
            hover:text-foreground
          "
          onClick={() => props.onChange(null)}
        >
          Cambiar
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        className={inputCls}
        placeholder="Buscar proveedor…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />

      {open && (
        <div className="
          absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border
          border-border bg-card shadow-lg
        "
        >
          {props.loading
            ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  Cargando…
                </div>
              )
            : filtered.length === 0
              ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    Sin coincidencias
                  </div>
                )
              : (
                  filtered.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        props.onChange(o);
                        setOpen(false);
                        setQuery('');
                      }}
                      className="
                        flex w-full flex-col items-start px-3 py-2 text-left
                        hover:bg-muted/50
                      "
                    >
                      <span className="text-sm font-medium">{o.name}</span>
                      {o.company && (
                        <span className="text-xs text-muted-foreground">
                          {o.company}
                        </span>
                      )}
                    </button>
                  ))
                )}

          <button
            type="button"
            onClick={props.onQuickCreate}
            className="
              flex w-full items-center gap-2 border-t border-border px-3 py-2.5
              text-left text-sm font-medium text-primary
              hover:bg-primary/5
            "
          >
            + Crear proveedor rápido
          </button>
        </div>
      )}
    </div>
  );
}
