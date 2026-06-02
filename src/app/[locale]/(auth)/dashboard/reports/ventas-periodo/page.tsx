'use client';

import type { WeekdayRow } from '@/actions/analytics';
import type { SalesByPeriodRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSalesByWeekday } from '@/actions/analytics';
import { getSalesByPeriod } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ChartCard, ColumnBars, TrendChart } from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<SalesByPeriodRow>[] = [
  { header: 'Fecha', key: 'day' },
  { header: 'Ventas', key: 'count', align: 'right' },
  {
    header: 'Total',
    key: 'total',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Ticket prom.',
    key: 'avgTicket',
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

export default function VentasPeriodoPage() {
  const [rows, setRows] = useState<SalesByPeriodRow[]>([]);
  const [weekday, setWeekday] = useState<WeekdayRow[]>([]);
  const rangeRef = useRef({ start: '', end: '' });

  const load = useCallback(async (start: string, end: string) => {
    rangeRef.current = { start, end };
    const [data, byWeekday] = await Promise.all([
      getSalesByPeriod(start, end),
      getSalesByWeekday(start, end),
    ]);
    setRows(data);
    setWeekday(byWeekday);
  }, []);

  return (
    <ReportShell
      title="Ventas por período"
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'ventas_periodo')}
      onExportPDF={() => exportToPDF('Ventas por período', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <div className="space-y-4">
            <ChartCard
              title="Ingresos vs ganancia por día"
              description="La distancia entre las dos líneas es lo que te cuesta la mercadería."
            >
              <TrendChart
                data={rows as unknown as Record<string, unknown>[]}
                xKey="day"
                series={[
                  { key: 'total', name: 'Ingresos', color: '#0F766E' },
                  { key: 'profit', name: 'Ganancia', color: '#15803D' },
                ]}
              />
            </ChartCard>
            <ChartCard
              title="Qué día vendés más"
              description="El patrón semanal. Programá compras y personal según tus días fuertes."
            >
              <ColumnBars
                data={weekday as unknown as Record<string, unknown>[]}
                labelKey="label"
                valueKey="total"
                name="Ingresos"
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
