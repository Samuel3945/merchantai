'use server';

import { Buffer } from 'node:buffer';
import { createOpenAI } from '@ai-sdk/openai';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { consumeCredit } from '@/actions/plans';
import { Env } from '@/libs/Env';
import { resolveOrgOpenAiKey } from '@/libs/openai-key';

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

const EXTRACT_MODEL = 'gpt-4o-mini'; // multimodal — reads images.

const extractSchema = z.object({
  products: z
    .array(
      z.object({
        name: z.string().describe('Nombre del producto'),
        price: z
          .string()
          .describe('Precio de venta solo en números, sin símbolo. Vacío si no se ve.'),
        category: z
          .string()
          .describe('Categoría comercial corta, o vacío si no se infiere.'),
      }),
    )
    .describe('Productos detectados en la imagen'),
});

type ExtractResult
  = | { ok: true; rows: Record<string, string>[]; remaining: number }
    | { ok: false; reason: 'no_key' | 'empty' };

// AI extraction of products from a PHOTO (price list, shelf, invoice, handwritten
// note) into the same header-keyed rows the grid consumes. BYOK precedence like
// categorizeProduct: the org's own key bills their account; otherwise the
// platform key is used and one credit is spent. Returns reason:'no_key' (so the
// UI can tell the owner to configure the key) instead of throwing.
export async function extractProductsFromImage(
  formData: FormData,
): Promise<ExtractResult> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    throw new Error('Not authenticated');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    throw new TypeError('Archivo inválido');
  }

  const byok = await resolveOrgOpenAiKey(orgId);
  const apiKey = byok ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'no_key' };
  }

  let remaining = Number.POSITIVE_INFINITY;
  if (!byok) {
    const credit = await consumeCredit('sales_manager');
    if (!credit.success) {
      return { ok: false, reason: 'no_key' };
    }
    remaining = credit.remaining;
  }

  const image = new Uint8Array(await file.arrayBuffer());
  const openai = createOpenAI({ apiKey });
  const { object } = await generateObject({
    model: openai(EXTRACT_MODEL),
    schema: extractSchema,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extrae todos los productos visibles en esta imagen (lista de precios, foto de estante, factura o nota escrita a mano). Para cada uno indica el nombre, el precio de venta (solo números) y una categoría comercial corta si puedes inferirla. Responde en español.',
          },
          { type: 'image', image },
        ],
      },
    ],
  });

  const rows = object.products
    .filter(p => p.name.trim() !== '')
    .map(p => ({
      nombre: p.name.trim(),
      precio: p.price.trim(),
      categoria: p.category.trim(),
    }));

  if (rows.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, rows, remaining };
}
