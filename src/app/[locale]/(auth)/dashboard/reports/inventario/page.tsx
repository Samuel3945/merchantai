'use client';

import type { InventoryHealth } from '@/actions/analytics';
import type { InventoryRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getInventoryHealth } from '@/actions/analytics';
import { getInventoryValuation } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { fmtMoney } from '@/features/reports/format';
import {
  ChartCard,
  RankBars,
  StatTile,
} from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<InventoryRow>[] = [
  { header: 'Categoría', key: 'category' },
  { header: 'Productos', key: 'productCount', align: 'right' },
  {
    header: 'Valor total',
    key: 'totalValue',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Agotados',
    key: 'outOfStock',
    align: 'right',
    render: v => (
      <span className={(v as number) > 0 ? 'font-medium text-red-600' : ''}>
        {String(v)}
      </span>
    ),
  },
  {
    header: 'Stock bajo',
    key: 'lowStock',
    align: 'right',
    render: v => (
      <span className={(v as number) > 0 ? 'font-medium text-amber-600' : ''}>
        {String(v)}
      </span>
    ),
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

const EMPTY_HEALTH: InventoryHealth = {
  value: 0,
  products: 0,
  outOfStock: 0,
  lowStock: 0,
  overstock: 0,
  cogs30d: 0,
  turnover: 0,
  daysOfInventory: 0,
  deadStock: [],
};

export default function InventarioPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [health, setHealth] = useState<InventoryHealth>(EMPTY_HEALTH);

  const load = useCallback(async () => {
    const [valuation, h] = await Promise.all([
      getInventoryValuation(),
      getInventoryHealth(),
    ]);
    setRows(valuation);
    setHealth(h);
  }, []);

  return (
    <ReportShell
      title="Inventario valorizado"
      showDateRange={false}
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'inventario')}
      onExportPDF={() => exportToPDF('Inventario valorizado', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {() => (
        <LoadOnce onLoad={load}>
          <div className="mb-3 flex flex-wrap gap-4">
            <Stat label="Valor total" value={money.format(rows.reduce((s, r) => s + r.totalValue, 0))} />
            <Stat label="Productos" value={String(rows.reduce((s, r) => s + r.productCount, 0))} />
            <Stat
              label="Agotados"
              value={String(rows.reduce((s, r) => s + r.outOfStock, 0))}
              className="text-red-600"
            />
            <Stat
              label="Stock bajo"
              value={String(rows.reduce((s, r) => s + r.lowStock, 0))}
              className="text-amber-600"
            />
          </div>
          <div className="
            mb-4 grid grid-cols-2 gap-3
            sm:grid-cols-4
          "
          >
            <StatTile
              label="Rotación (30d)"
              value={`${health.turnover.toFixed(2)}x`}
              hint="veces que vendés todo el stock"
            />
            <StatTile
              label="Días de inventario"
              value={health.daysOfInventory > 0 ? `${Math.round(health.daysOfInventory)} días` : '—'}
              hint="cuánto te dura el stock"
            />
            <StatTile
              label="Sobrestock"
              value={String(health.overstock)}
              tone={health.overstock > 0 ? 'warn' : 'default'}
              hint="por encima del máximo"
            />
            <StatTile
              label="Sin rotación"
              value={String(health.deadStock.length)}
              tone={health.deadStock.length > 0 ? 'warn' : 'default'}
              hint="sin vender hace +30d"
            />
          </div>

          {rows.length > 0 && (
            <ChartCard
              title="Valor del inventario por categoría"
              description="Dónde tenés inmovilizado tu capital."
              className="mb-4"
            >
              <RankBars
                data={[...rows].sort((a, b) => b.totalValue - a.totalValue).slice(0, 10) as unknown as Record<string, unknown>[]}
                labelKey="category"
                valueKey="totalValue"
                name="Valor"
              />
            </ChartCard>
          )}

          <DataTable columns={columns} rows={rows} emptyMessage="Sin productos en inventario" />

          {health.deadStock.length > 0 && (
            <div className="mt-4 rounded-lg border bg-background shadow-xs">
              <div className="border-b px-4 py-3 text-sm font-semibold">
                Productos sin rotación (capital dormido)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase">
                    <tr>
                      <th className="px-3 py-2">Producto</th>
                      <th className="px-3 py-2 text-right">Stock</th>
                      <th className="px-3 py-2 text-right">Valor</th>
                      <th className="px-3 py-2 text-right">Sin vender</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.deadStock.map(p => (
                      <tr key={p.name} className="border-t">
                        <td className="px-3 py-2">{p.name}</td>
                        <td className="px-3 py-2 text-right">{p.stock}</td>
                        <td className="px-3 py-2 text-right font-medium">
                          {fmtMoney(p.value)}
                        </td>
                        <td className="
                          px-3 py-2 text-right text-muted-foreground
                        "
                        >
                          {p.daysSinceLastSale === null
                            ? 'nunca'
                            : `${p.daysSinceLastSale} días`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </LoadOnce>
      )}
    </ReportShell>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg border bg-background px-4 py-2 shadow-xs">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`
        text-lg font-semibold
        ${className ?? ''}
      `}
      >
        {value}
      </div>
    </div>
  );
}

function LoadOnce({ onLoad, children }: { onLoad: () => Promise<void>; children: React.ReactNode }) {
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      onLoad();
    }
  }, [onLoad]);
  return <>{children}</>;
}
