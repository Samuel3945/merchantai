'use client';

import type { LossRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLossReport } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ChartCard, DonutChart } from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<LossRow>[] = [
  { header: 'Fecha', key: 'date' },
  { header: 'Producto', key: 'productName' },
  { header: 'Razón', key: 'reason' },
  { header: 'Qty', key: 'qty', align: 'right' },
  {
    header: 'Costo unit.',
    key: 'unitCost',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Pérdida total',
    key: 'totalLoss',
    align: 'right',
    render: v => (
      <span className="font-medium text-red-600">{money.format(v as number)}</span>
    ),
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function PerdidasPage() {
  const [rows, setRows] = useState<LossRow[]>([]);

  const load = useCallback(async (start: string, end: string) => {
    setRows(await getLossReport(start, end));
  }, []);

  return (
    <ReportShell
      title="Pérdidas (mermas)"
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'perdidas')}
      onExportPDF={() => exportToPDF('Pérdidas (mermas)', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <div className="mb-3 flex flex-wrap gap-4">
            <Stat label="Pérdida total" value={money.format(rows.reduce((s, r) => s + r.totalLoss, 0))} />
            <Stat label="Items afectados" value={String(rows.length)} />
          </div>
          {rows.length > 0 && (
            <ChartCard
              title="Pérdidas por razón"
              description="A dónde se va la mercadería: vencida, dañada, perdida."
              className="mb-4"
            >
              <DonutChart
                data={lossesByReason(rows)}
                nameKey="reason"
                valueKey="totalLoss"
              />
            </ChartCard>
          )}
          <DataTable columns={columns} rows={rows} emptyMessage="Sin mermas registradas en el rango" />
        </Loader>
      )}
    </ReportShell>
  );
}

function lossesByReason(rows: LossRow[]): Record<string, unknown>[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.reason, (map.get(r.reason) ?? 0) + r.totalLoss);
  }
  return Array.from(map, ([reason, totalLoss]) => ({ reason, totalLoss }));
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background px-4 py-2 shadow-xs">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-red-600">{value}</div>
    </div>
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
