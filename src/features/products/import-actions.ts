'use server';

import { Buffer } from 'node:buffer';
import { createOpenAI } from '@ai-sdk/openai';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import ExcelJS from 'exceljs';
import { extractText, getDocumentProxy } from 'unpdf';
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

type ExtractedProduct = z.infer<typeof extractSchema>['products'][number];

type ExtractResult
  = | { ok: true; rows: Record<string, string>[]; remaining: number }
    | { ok: false; reason: 'no_key' | 'empty' };

// Resolves AI access with BYOK precedence: the org's own OpenAI key bills their
// account (no credit spent); otherwise the platform key is used and one credit
// is consumed. null means no usable key — callers return reason:'no_key' instead
// of throwing, so the UI can tell the owner to configure the key.
async function resolveAiAccess(
  orgId: string,
): Promise<{ apiKey: string; remaining: number } | null> {
  const byok = await resolveOrgOpenAiKey(orgId);
  const apiKey = byok ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (byok) {
    return { apiKey, remaining: Number.POSITIVE_INFINITY };
  }
  const credit = await consumeCredit('sales_manager');
  if (!credit.success) {
    return null;
  }
  return { apiKey, remaining: credit.remaining };
}

// Maps the model's products into the header-keyed rows recordsToDrafts expects.
function productsToRows(products: ExtractedProduct[]): Record<string, string>[] {
  return products
    .filter(p => p.name.trim() !== '')
    .map(p => ({
      nombre: p.name.trim(),
      precio: p.price.trim(),
      categoria: p.category.trim(),
    }));
}

// AI extraction of products from a PHOTO (price list, shelf, invoice, handwritten
// note) into the same header-keyed rows the grid consumes.
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

  const access = await resolveAiAccess(orgId);
  if (!access) {
    return { ok: false, reason: 'no_key' };
  }

  const image = new Uint8Array(await file.arrayBuffer());
  const openai = createOpenAI({ apiKey: access.apiKey });
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

  const rows = productsToRows(object.products);
  if (rows.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, rows, remaining: access.remaining };
}

// AI extraction from a text-based PDF (price list, catalog, invoice). The text is
// extracted locally first — so a scanned/imageless PDF returns 'empty' without
// spending a credit — then structured by the model. Scanned-PDF vision is out of
// scope (use a photo for those).
export async function extractProductsFromPdf(
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

  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }

  const access = await resolveAiAccess(orgId);
  if (!access) {
    return { ok: false, reason: 'no_key' };
  }

  const openai = createOpenAI({ apiKey: access.apiKey });
  const { object } = await generateObject({
    model: openai(EXTRACT_MODEL),
    schema: extractSchema,
    prompt: `Este es el texto extraído de un PDF de un negocio (lista de precios, catálogo o factura). Extrae todos los productos: nombre, precio de venta (solo números) y una categoría comercial corta si puedes inferirla. Ignora encabezados, totales, impuestos y texto que no sea un producto. Responde en español.\n\nTEXTO:\n${trimmed.slice(0, 12000)}`,
  });

  const rows = productsToRows(object.products);
  if (rows.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, rows, remaining: access.remaining };
}
