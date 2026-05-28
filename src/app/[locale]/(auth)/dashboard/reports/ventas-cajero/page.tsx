'use client';

import type { SalesByCashierRow } from '@/actions/reports';
import type { Column } from '@/features/reports/DataTable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSalesByCashier } from '@/actions/reports';
import { DataTable } from '@/features/reports/DataTable';
import { ReportShell } from '@/features/reports/ReportShell';
import { exportToCSV, exportToPDF } from '@/libs/exports';

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const columns: Column<SalesByCashierRow>[] = [
  { header: 'Cajero', key: 'cashierName' },
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
];

const pdfCols = columns.map(c => ({ header: c.header, key: c.key, align: c.align }));

export default function VentasCajeroPage() {
  const [rows, setRows] = useState<SalesByCashierRow[]>([]);

  const load = useCallback(async (start: string, end: string) => {
    setRows(await getSalesByCashier(start, end));
  }, []);

  return (
    <ReportShell
      title="Ventas por cajero"
      onExportCSV={() => exportToCSV(rows as unknown as Record<string, unknown>[], 'ventas_cajero')}
      onExportPDF={() => exportToPDF('Ventas por cajero', rows as unknown as Record<string, unknown>[], pdfCols)}
    >
      {({ start, end }) => (
        <Loader start={start} end={end} onLoad={load}>
          <DataTable columns={columns} rows={rows} emptyMessage="Sin ventas atribuidas a cajeros" />
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
