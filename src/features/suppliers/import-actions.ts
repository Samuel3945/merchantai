'use server';

import { createOpenAI } from '@ai-sdk/openai';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { resolveAiAccess } from '@/libs/ai-import-access';

// The generic .xlsx parser lives in `@/libs/spreadsheet-import`; the client
// imports it from there directly, so it is not re-exported here.

const EXTRACT_MODEL = 'gpt-4o-mini'; // multimodal — reads images.

const extractSchema = z.object({
  suppliers: z
    .array(
      z.object({
        name: z.string().describe('Nombre del proveedor o de la persona de contacto'),
        phone: z
          .string()
          .describe('Teléfono o celular, solo dígitos y signos. Vacío si no se ve.'),
        email: z.string().describe('Correo electrónico, o vacío si no se ve.'),
        city: z.string().describe('Ciudad, o vacío si no se infiere.'),
      }),
    )
    .describe('Proveedores detectados en la imagen'),
});

type ExtractedSupplier = z.infer<typeof extractSchema>['suppliers'][number];

type ExtractResult
  = | { ok: true; rows: Record<string, string>[]; remaining: number }
    | { ok: false; reason: 'no_key' | 'empty' };

// Maps the model's suppliers into the header-keyed rows recordsToDrafts expects.
function suppliersToRows(suppliers: ExtractedSupplier[]): Record<string, string>[] {
  return suppliers
    .filter(s => s.name.trim() !== '')
    .map(s => ({
      nombre: s.name.trim(),
      telefono: s.phone.trim(),
      correo: s.email.trim(),
      ciudad: s.city.trim(),
    }));
}

// AI extraction of suppliers from a PHOTO (a contact list, a stack of business
// cards, an invoice header) into the same header-keyed rows the grid consumes.
export async function extractSuppliersFromImage(
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
            text: 'Extrae todos los proveedores o contactos comerciales visibles en esta imagen (lista de contactos, tarjetas de presentación, encabezado de factura o nota escrita a mano). Para cada uno indica el nombre, el teléfono, el correo y la ciudad si puedes inferirla. Responde en español.',
          },
          { type: 'image', image },
        ],
      },
    ],
  });

  const rows = suppliersToRows(object.suppliers);
  if (rows.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, rows, remaining: access.remaining };
}

// AI extraction from a text-based PDF (contact list, supplier directory, invoice).
// The text is extracted locally first — so a scanned/imageless PDF returns 'empty'
// without spending a credit — then structured by the model. Scanned-PDF vision is
// out of scope (use a photo for those).
export async function extractSuppliersFromPdf(
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
    prompt: `Este es el texto extraído de un PDF de un negocio (lista de contactos, directorio de proveedores o factura). Extrae todos los proveedores: nombre, teléfono, correo y ciudad si puedes inferirla. Ignora encabezados, totales, impuestos y texto que no sea un proveedor. Responde en español.\n\nTEXTO:\n${trimmed.slice(0, 12000)}`,
  });

  const rows = suppliersToRows(object.suppliers);
  if (rows.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, rows, remaining: access.remaining };
}
