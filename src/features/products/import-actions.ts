'use server';

import { Buffer } from 'node:buffer';
import { auth } from '@clerk/nextjs/server';
import ExcelJS from 'exceljs';

// Parses an uploaded .xlsx into header-keyed records, the same shape papaparse
// produces for CSV — so the client feeds both through the same recordsToDrafts.
// Runs server-side so the (heavy) spreadsheet parser never reaches the client
// bundle. The first sheet's first row is treated as the header row.
const MAX_ROWS = 2000;

export async function parseSpreadsheetRows(
  formData: FormData,
): Promise<Record<string, string>[]> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    throw new TypeError('Archivo inválido');
  }

  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));
  // exceljs types load() as Buffer; @types/node's invariant Buffer<ArrayBuffer>
  // generic doesn't match its Buffer<ArrayBufferLike>, so narrow to the exact
  // expected parameter type. Runtime is unaffected.
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return [];
  }

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col - 1] = String(cell.text ?? '').trim();
  });

  const records: Record<string, string>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || records.length >= MAX_ROWS) {
      return;
    }
    const record: Record<string, string> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const header = headers[col - 1];
      if (header) {
        record[header] = String(cell.text ?? '').trim();
      }
    });
    if (Object.keys(record).length > 0) {
      records.push(record);
    }
  });

  return records;
}
