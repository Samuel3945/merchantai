'use client';

import type { InventoryProduct } from '@/actions/inventory';

function Card({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`
        text-2xl font-semibold
        ${tone ?? ''}
      `}
      >
        {value}
      </div>
    </div>
  );
}

export function InventoryKpis({
  products,
  inventoryValue,
  expiringCount,
}: {
  products: InventoryProduct[];
  inventoryValue: string;
  expiringCount: number;
}) {
  const totalStock = products.reduce((s, p) => s + p.stock, 0);
  const lowCount = products.filter(p => p.status === 'low').length;
  const criticalCount = products.filter(p => p.status === 'critical').length;
  const value = Number(inventoryValue) || 0;

  return (
    <div className="
      grid grid-cols-2 gap-3
      sm:grid-cols-3
      lg:grid-cols-6
    "
    >
      <Card label="Productos" value={products.length} />
      <Card label="Stock total" value={totalStock} />
      <Card label="Stock bajo" value={lowCount} tone="text-warn" />
      <Card label="Por vencer" value={expiringCount} tone="text-terracotta" />
      <Card label="Agotados" value={criticalCount} tone="text-destructive" />
      <Card
        label="Valor del inventario"
        value={`$${value.toLocaleString('es-CO')}`}
        tone="text-brand"
      />
    </div>
  );
}
