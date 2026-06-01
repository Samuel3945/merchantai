'use client';

import { cn } from '@/utils/Helpers';

export type UITier = { minQty: string; price: string };

const tierInputCls
  = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Port of Tiendademo's WholesaleTiersEditor. Validation is visual here; the
// authoritative rules run server-side in validation.ts (refineProduct).
export function WholesaleTiersEditor({
  price,
  tiers,
  onChange,
}: {
  price: number;
  tiers: UITier[];
  onChange: (tiers: UITier[]) => void;
}) {
  const addTier = () => onChange([...tiers, { minQty: '', price: '' }]);
  const updateTier = (i: number, patch: Partial<UITier>) =>
    onChange(tiers.map((t, j) => (i === j ? { ...t, ...patch } : t)));
  const removeTier = (i: number) => onChange(tiers.filter((_, j) => j !== i));

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="
          text-xs font-semibold tracking-wider text-muted-foreground uppercase
        "
        >
          Tiers de precio por mayor
        </p>
        <button
          type="button"
          onClick={addTier}
          className="
            text-xs font-semibold text-primary
            hover:underline
          "
        >
          + Agregar tier
        </button>
      </div>

      {tiers.length === 0
        ? (
            <p className="text-xs text-muted-foreground">
              Sin tiers. Define precios más bajos al comprar grandes cantidades.
            </p>
          )
        : (
            tiers.map((tier, i) => {
              const q = Number.parseFloat(tier.minQty);
              const p = Number.parseFloat(tier.price);
              const prevQ = i > 0 ? Number.parseFloat(tiers[i - 1]!.minQty) : Number.NaN;
              const invalid
                = (Number.isFinite(q) && q < 2)
                  || (Number.isFinite(p) && p > 0 && price > 0 && p >= price)
                  || (i > 0 && Number.isFinite(q) && Number.isFinite(prevQ) && q <= prevQ);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Si compran ≥</span>
                  <input
                    type="number"
                    min="2"
                    value={tier.minQty}
                    onChange={e => updateTier(i, { minQty: e.target.value })}
                    placeholder="10"
                    className={cn(tierInputCls, 'w-20', invalid && `
                      border-destructive
                    `)}
                  />
                  <span className="text-xs text-muted-foreground">→ precio</span>
                  <input
                    type="number"
                    min="0"
                    step="50"
                    value={tier.price}
                    onChange={e => updateTier(i, { price: e.target.value })}
                    placeholder="0"
                    className={cn(tierInputCls, 'flex-1', invalid && `
                      border-destructive
                    `)}
                  />
                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    className="
                      text-muted-foreground
                      hover:text-destructive
                    "
                    aria-label="Quitar tier"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}

      <p className="text-[10px] text-muted-foreground">
        Reglas: cantidad ≥ 2, crecientes; precio mayor &lt; precio normal; precios decrecientes.
      </p>
    </div>
  );
}
