'use client';

import { Plus, X } from 'lucide-react';
import { cn } from '@/utils/Helpers';

export type UITier = { minQty: string; price: string };

const tierInputCls
  = 'h-9 w-24 rounded-md border border-input bg-transparent px-2 text-center text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

// Plain-language editor for quantity-based pricing ("buy more, pay less").
// The owner never sees the word "tier". Validation is visual here; the
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
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div>
        <p className="text-sm font-semibold">Precio especial por cantidad</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          ¿Cobrás más barato cuando alguien lleva muchas unidades? Definilo acá.
          {price > 0 && (
            <>
              {' '}
              Ejemplo: 1 unidad vale
              {' '}
              {money(price)}
              , pero si llevan 10 o más, cada una sale
              {' '}
              {money(price * 0.85)}
              .
            </>
          )}
        </p>
      </div>

      {tiers.map((tier, i) => {
        const q = Number.parseFloat(tier.minQty);
        const p = Number.parseFloat(tier.price);
        const prevQ = i > 0 ? Number.parseFloat(tiers[i - 1]!.minQty) : Number.NaN;

        const qtyTooLow = Number.isFinite(q) && q < 2;
        const qtyNotIncreasing
          = i > 0 && Number.isFinite(q) && Number.isFinite(prevQ) && q <= prevQ;
        const priceTooHigh
          = Number.isFinite(p) && p > 0 && price > 0 && p >= price;

        const invalid = qtyTooLow || qtyNotIncreasing || priceTooHigh;
        const errorMsg = qtyTooLow
          ? 'La cantidad tiene que ser 2 o más.'
          : qtyNotIncreasing
            ? 'Esta cantidad debe ser mayor que la del renglón de arriba.'
            : priceTooHigh
              ? `El precio tiene que ser más barato que ${money(price)} (tu precio normal).`
              : null;

        return (
          <div key={i} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Si llevan</span>
              <input
                inputMode="numeric"
                value={tier.minQty}
                onChange={e =>
                  updateTier(i, { minQty: e.target.value.replace(/\D/g, '') })}
                placeholder="10"
                className={cn(tierInputCls, invalid && 'border-destructive')}
              />
              <span className="text-muted-foreground">o más, cada una a</span>
              <span className="text-muted-foreground">$</span>
              <input
                inputMode="decimal"
                value={tier.price}
                onChange={e => updateTier(i, { price: e.target.value })}
                placeholder="1700"
                className={cn(tierInputCls, invalid && 'border-destructive')}
              />
              <button
                type="button"
                onClick={() => removeTier(i)}
                className="
                  ml-auto rounded-md p-1 text-muted-foreground
                  hover:bg-accent hover:text-destructive
                "
                aria-label="Quitar este precio"
              >
                <X className="size-4" />
              </button>
            </div>
            {errorMsg && (
              <p className="text-xs text-destructive">{errorMsg}</p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addTier}
        className="
          flex items-center gap-1.5 rounded-md border border-dashed border-input
          px-3 py-2 text-xs font-semibold text-muted-foreground
          transition-colors
          hover:border-primary hover:bg-primary/5 hover:text-primary
        "
      >
        <Plus className="size-4" />
        Agregar un precio por cantidad
      </button>
    </div>
  );
}
