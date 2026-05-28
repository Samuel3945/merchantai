import Papa from 'papaparse';
import pdfMake from 'pdfmake/build/pdfmake';

type Column = {
  header: string;
  key: string;
  align?: 'left' | 'center' | 'right';
};

export function exportToCSV(
  rows: Record<string, unknown>[],
  filename: string,
) {
  const csv = Papa.unparse(rows);
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

export function exportToPDF(
  title: string,
  rows: Record<string, unknown>[],
  columns: Column[],
) {
  const headerRow = columns.map(c => ({
    text: c.header,
    bold: true,
    fontSize: 9,
    fillColor: '#f3f4f6',
    alignment: (c.align ?? 'left') as 'left' | 'center' | 'right',
    margin: [4, 6, 4, 6] as [number, number, number, number],
  }));

  const bodyRows = rows.map(row =>
    columns.map(c => ({
      text: String(row[c.key] ?? ''),
      fontSize: 8,
      alignment: (c.align ?? 'left') as 'left' | 'center' | 'right',
      margin: [4, 4, 4, 4] as [number, number, number, number],
    })),
  );

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  });

  const docDefinition = {
    pageSize: 'LETTER' as const,
    pageOrientation: columns.length > 5 ? ('landscape' as const) : ('portrait' as const),
    pageMargins: [40, 60, 40, 40] as [number, number, number, number],
    content: [
      { text: title, fontSize: 16, bold: true, margin: [0, 0, 0, 4] as [number, number, number, number] },
      { text: `Generado: ${dateStr}`, fontSize: 8, color: '#6b7280', margin: [0, 0, 0, 12] as [number, number, number, number] },
      {
        table: {
          headerRows: 1,
          widths: columns.map(() => '*'),
          body: [headerRow, ...bodyRows],
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => '#e5e7eb',
          vLineColor: () => '#e5e7eb',
        },
      },
      { text: `Total de registros: ${rows.length}`, fontSize: 8, color: '#6b7280', margin: [0, 8, 0, 0] as [number, number, number, number] },
    ],
  };

  pdfMake.createPdf(docDefinition).download(
    `${title.replace(/\s+/g, '_')}_${now.toISOString().slice(0, 10)}.pdf`,
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
