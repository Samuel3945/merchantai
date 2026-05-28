'use client';

import type { CashAnalysisRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCashAnalysis } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';
import { cn } from '@/utils/Helpers';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

function fmtDate(v: unknown) {
  if (!v) {
    return '';
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : dateFmt.format(d);
}

const columns: Column<CashAnalysisRow>[] = [
  { header: 'Cerrado', key: 'closedAt', render: v => fmtDate(v) },
  { header: 'Abierto por', key: 'openedBy' },
  { header: 'Cerrado por', key: 'closedBy' },
  {
    header: 'Apertura',
    key: 'openingAmount',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Esperado',
    key: 'expectedAmount',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Contado',
    key: 'countedAmount',
    align: 'right',
    render: v => money.format(v as number),
  },
  {
    header: 'Diferencia',
    key: 'difference',
    align: 'right',
    render: (v, row) => (
      <span className={cn(row.hasFraudAlert ? 'font-bold text-red-600' : '')}>
        {money.format(v as number)}
      </span>
    ),
  },
  {
    header: 'Alerta',
    key: 'hasFraudAlert',
    align: 'center',
    render: v => (v ? 'SI' : ''),
  },
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function AnalisisCajaPage() {
  const [rows, setRows] = useState<CashAnalysisRow[]>([]);

  const load = useCallback(async (start: string, end: string) => {
    setRows(await getCashAnalysis(start, end));
  }, []);

  return (
    <ReportShell
      title="Análisis de caja"
      onExportCSV={() => exportToCSV(
        rows.map(r => ({ ...r, closedAt: fmtDate(r.closedAt), openedAt: fmtDate(r.openedAt) })),
        'analisis_caja',
      )}
      onExportPDF={() => exportToPDF(
        'Análisis de caja',
        rows.map(r => ({
          ...r,
          closedAt: fmtDate(r.closedAt),
          openedAt: fmtDate(r.openedAt),
          hasFraudAlert: r.hasFraudAlert ? 'SI' : 'NO',
        })) as unknown as Record<string, unknown>[],
        pdfCols,
      )}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <DataTable columns={columns} rows={rows} emptyMessage="Sin sesiones cerradas en el rango" />
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
