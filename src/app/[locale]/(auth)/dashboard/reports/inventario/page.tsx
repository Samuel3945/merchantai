'use client';

import type { InventoryRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getInventoryValuation } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
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

export default function InventarioPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);

  const load = useCallback(async () => {
    setRows(await getInventoryValuation());
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
          <DataTable columns={columns} rows={rows} emptyMessage="Sin productos en inventario" />
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
