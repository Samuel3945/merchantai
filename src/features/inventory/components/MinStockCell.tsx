'use client';

import type { InventoryProduct } from '@/actions/inventory';
import { SparklesIcon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { updateMinStock } from '@/actions/inventory';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';

const inputCls
  = 'h-7 w-16 rounded-md border border-input bg-transparent px-2 text-right text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// MIN column cell. Editable by hand by default; read-only with an "IA" mark and
// an explanatory tooltip while Smart Stock manages the reorder point.
export function MinStockCell({
  product,
  onSaved,
}: {
  product: InventoryProduct;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(product.minStock));
  const [pending, startTransition] = useTransition();

  if (product.aiManaged) {
    const tooltip
      = product.aiWeeklySales != null
        ? `Ajustado por IA: vendés ~${product.aiWeeklySales}/semana`
        : 'Ajustado automáticamente por IA';
    return (
      <span
        title={tooltip}
        className="inline-flex items-center gap-1 font-mono text-xs text-brand"
      >
        <SparklesIcon className="size-3" />
        {product.minStock}
      </span>
    );
  }

  function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      toast.error('El mínimo debe ser un entero ≥ 0');
      return;
    }
    if (n === product.minStock) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      try {
        await updateMinStock(product.id, n);
        toast.success(`Mínimo de "${product.name}" actualizado`);
        setEditing(false);
        onSaved();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo guardar');
      }
    });
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min="0"
        value={value}
        disabled={pending}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            save();
          }
          if (e.key === 'Escape') {
            setValue(String(product.minStock));
            setEditing(false);
          }
        }}
        className={inputCls}
        onClick={e => e.stopPropagation()}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={cn(
        `
          rounded-sm px-1 font-mono text-xs underline-offset-2
          hover:bg-accent hover:underline
        `,
      )}
      title="Editar stock mínimo"
    >
      {product.minStock}
    </button>
  );
}
