'use client';

export type AttrRow = { key: string; value: string };

const attrInputCls
  = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// `suggestions` are attributes the AI (or the category template) proposed for
// the product. They render as tappable chips — nothing is added to the form
// until the user selects one; tapping prefills both the name and any value the
// AI inferred.
export function AttributesEditor({
  suggestions,
  attributes,
  onChange,
}: {
  suggestions: AttrRow[];
  attributes: AttrRow[];
  onChange: (attrs: AttrRow[]) => void;
}) {
  const update = (i: number, patch: Partial<AttrRow>) =>
    onChange(attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const addRow = (key = '', value = '') =>
    onChange([...attributes, { key, value }]);
  const removeRow = (i: number) => onChange(attributes.filter((_, j) => j !== i));

  const openSuggestions = suggestions.filter(
    s => !attributes.some(a => a.key.toLowerCase() === s.key.toLowerCase()),
  );

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="
          text-xs font-semibold tracking-wider text-muted-foreground uppercase
        "
        >
          Características
        </p>
        <button
          type="button"
          onClick={() => addRow()}
          className="
            text-xs font-semibold text-primary
            hover:underline
          "
        >
          + Agregar
        </button>
      </div>

      {openSuggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            Sugerencias — toca una para agregarla:
          </p>
          <div className="flex flex-wrap gap-1">
            {openSuggestions.map(s => (
              <button
                key={s.key}
                type="button"
                onClick={() => addRow(s.key, s.value)}
                className="
                  rounded-full bg-secondary px-2 py-0.5 text-[10px]
                  text-secondary-foreground
                  hover:bg-secondary/70
                "
              >
                +
                {' '}
                {s.value ? `${s.key}: ${s.value}` : s.key}
              </button>
            ))}
          </div>
        </div>
      )}

      {attributes.length === 0 && openSuggestions.length === 0
        ? (
            <p className="text-xs text-muted-foreground">
              Sin características. Agrega marca, talla, etc.
            </p>
          )
        : (
            attributes.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={a.key}
                  onChange={e => update(i, { key: e.target.value })}
                  placeholder="Marca, RAM, Talla…"
                  className={`
                    ${attrInputCls}
                    w-32
                  `}
                />
                <span className="text-xs text-muted-foreground">:</span>
                <input
                  type="text"
                  value={a.value}
                  onChange={e => update(i, { value: e.target.value })}
                  placeholder="Valor"
                  className={`
                    ${attrInputCls}
                    flex-1
                  `}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="
                    text-muted-foreground
                    hover:text-destructive
                  "
                  aria-label="Quitar característica"
                >
                  ✕
                </button>
              </div>
            ))
          )}
    </div>
  );
}
