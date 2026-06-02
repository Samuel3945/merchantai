'use client';

import type { CategoryMarginRow } from '@/actions/analytics';
import type { TopProductRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMarginByCategory } from '@/actions/analytics';
import { getTopProducts } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ChartCard, ColumnBars, RankBars } from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<TopProductRow>[] = [
  { header: 'Producto', key: 'name' },
  { header: 'Categoría', key: 'category' },
  { header: 'Qty', key: 'qty', align: 'right' },
  {
    header: 'Ingreso',
    key: 'revenue',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Costo',
    key: 'cost',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Ganancia',
    key: 'profit',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Margen %',
    key: 'margin',
    align: 'right',
    render: v => `${(v as number).toFixed(1)}%`,
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function TopProductosPage() {
  const [rows, setRows] = useState<TopProductRow[]>([]);
  const [margins, setMargins] = useState<CategoryMarginRow[]>([]);

  const load = useCallback(async (start: string, end: string) => {
    const [top, byCategory] = await Promise.all([
      getTopProducts(start, end),
      getMarginByCategory(start, end),
    ]);
    setRows(top);
    setMargins(byCategory);
  }, []);

  return (
    <ReportShell
      title="Top productos"
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'top_productos')}
      onExportPDF={() => exportToPDF('Top productos', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <div className="space-y-4">
            <ChartCard
              title="Top 10 por ingreso"
              description="Los que más plata te dejan. Nunca los dejes sin stock."
            >
              <RankBars
                data={rows.slice(0, 10) as unknown as Record<string, unknown>[]}
                labelKey="name"
                valueKey="revenue"
                name="Ingreso"
              />
            </ChartCard>
            <ChartCard
              title="Margen % por categoría"
              description="No vendas a ciegas: algunas categorías dejan mucho más que otras."
            >
              <ColumnBars
                data={margins as unknown as Record<string, unknown>[]}
                labelKey="category"
                valueKey="margin"
                name="Margen %"
                money={false}
                color="#15803D"
              />
            </ChartCard>
            <DataTable columns={columns} rows={rows} emptyMessage="Sin ventas en el rango seleccionado" />
          </div>
        </Loader>
      )}
    </ReportShell>
  );
}

function Loader({
  start,
  end,
  onLoad,
  children,
}: {
  start: string;
  end: string;
  onLoad: (s: string, e: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const prev = useRef('');
  useEffect(() => {
    const key = `${start}|${end}`;
    if (key !== prev.current) {
      prev.current = key;
      onLoad(start, end);
    }
  }, [start, end, onLoad]);
  return <>{children}</>;
}
