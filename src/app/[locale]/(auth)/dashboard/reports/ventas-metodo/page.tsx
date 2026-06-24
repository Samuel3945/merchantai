'use client';

import type { SalesByPaymentRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSalesByPayment } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ChartCard, DonutChart } from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<SalesByPaymentRow>[] = [
  { header: 'Método', key: 'method' },
  { header: 'Ventas', key: 'count', align: 'right' },
  {
    header: 'Total',
    key: 'total',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: '% del total',
    key: 'pct',
    align: 'right',
    render: v => `${(v as number).toFixed(1)}%`,
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function VentasMetodoPage() {
  const [rows, setRows] = useState<SalesByPaymentRow[]>([]);

  const load = useCallback(async (start: string, end: string) => {
    setRows(await getSalesByPayment(start, end));
  }, []);

  return (
    <ReportShell
      title="Ventas por método de pago"
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'ventas_metodo')}
      onExportPDF={() => exportToPDF('Ventas por método de pago', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <div className="space-y-4">
            <ChartCard
              title="Distribución por método de pago"
              description="Si el grueso es crédito o transferencia, es plata que aún no tenés en mano."
            >
              <DonutChart
                data={rows as unknown as Record<string, unknown>[]}
                nameKey="method"
                valueKey="total"
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
