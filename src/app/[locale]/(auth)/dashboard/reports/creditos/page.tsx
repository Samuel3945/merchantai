'use client';

import type { CreditoAgingBucket } from '@/actions/analytics';
import type { CreditoReportRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCreditosAging } from '@/actions/analytics';
import { getCreditoReport } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ChartCard, ColumnBars } from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';
import { cn } from '@/utils/Helpers';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function riskBadge(risk: string) {
  const cls = risk === 'alto'
    ? 'bg-red-100 text-red-700'
    : risk === 'medio'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-green-100 text-green-700';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', cls)}>
      {risk}
    </span>
  );
}

const columns: Column<CreditoReportRow>[] = [
  { header: 'Cliente', key: 'clientName' },
  { header: 'Ventas', key: 'saleCount', align: 'right' },
  {
    header: 'Deuda',
    key: 'totalOwed',
    align: 'right',
    render: v => money.format(v as number),
  },
  { header: 'Días', key: 'oldestDays', align: 'right' },
  {
    header: 'Riesgo',
    key: 'risk',
    align: 'center',
    render: v => riskBadge(v as string),
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function CreditosReportPage() {
  const [rows, setRows] = useState<CreditoReportRow[]>([]);
  const [aging, setAging] = useState<CreditoAgingBucket[]>([]);

  const load = useCallback(async () => {
    const [report, buckets] = await Promise.all([
      getCreditoReport(),
      getCreditosAging(),
    ]);
    setRows(report);
    setAging(buckets);
  }, []);

  return (
    <ReportShell
      title="Créditos pendientes"
      showDateRange={false}
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'creditos')}
      onExportPDF={() => exportToPDF('Créditos pendientes', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {() => (
        <LoadOnce onLoad={load}>
          <div className="mb-3 flex flex-wrap gap-4">
            <Stat label="Total adeudado" value={money.format(rows.reduce((s, r) => s + r.totalOwed, 0))} />
            <Stat label="Clientes" value={String(rows.length)} />
            <Stat
              label="Riesgo alto"
              value={String(rows.filter(r => r.risk === 'alto').length)}
              className="text-red-600"
            />
          </div>
          {rows.length > 0 && (
            <ChartCard
              title="Antigüedad de la deuda"
              description="Mientras más vieja la deuda, más difícil de cobrar. Atacá primero los tramos largos."
              className="mb-4"
            >
              <ColumnBars
                data={aging as unknown as Record<string, unknown>[]}
                labelKey="bucket"
                valueKey="amount"
                name="Deuda"
                color="#C2410C"
              />
            </ChartCard>
          )}
          <DataTable columns={columns} rows={rows} emptyMessage="Sin créditos pendientes" />
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
