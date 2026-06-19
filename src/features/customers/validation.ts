import { z } from 'zod';

const trimmedOrNull = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .transform(v => (v === '' || v === undefined ? null : v));

const decimalString = z
  .union([z.string(), z.number()])
  .transform(v => (typeof v === 'number' ? v.toString() : v))
  .refine(v => /^\d+(?:\.\d{1,2})?$/.test(v), {
    message: 'Must be a number with up to 2 decimals',
  });

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  documentId: trimmedOrNull,
  whatsapp: trimmedOrNull,
  email: trimmedOrNull,
  address: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v)),
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v)),
  // No `.default(true)` here: Zod keeps schema defaults through `.partial()`,
  // so a default would re-inject `marketingOptIn: true` on every edit and
  // silently re-subscribe a customer who had opted out. createCustomer applies
  // the `?? true` fallback explicitly instead.
  marketingOptIn: z.coerce.boolean().optional(),
  totalSpent: decimalString.optional(),
});

// `totalSpent` is an accumulator owned by sales (post-sale-hook), never by a
// manual edit — omit it so an update can't overwrite it. (Same class of bug as
// product stock: a base field leaking into a partial update.)
export const customerUpdateSchema = customerCreateSchema
  .omit({ totalSpent: true })
  .partial();

export type CustomerCreateInput = z.input<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.input<typeof customerUpdateSchema>;

// The canonical marker emitted by the POS is `CONSUMIDOR_FINAL` (underscore,
// see einvoice/emit.ts). `\s*` only matches whitespace, so it silently missed
// the real marker and the "skip anonymous sale" guard never fired. Allow the
// underscore (and any whitespace) between the two words.
const CONSUMIDOR_FINAL_RE = /consumidor[\s_]*final/i;

export function isConsumidorFinal(name: string | null | undefined): boolean {
  if (!name) {
    return false;
  }
  return CONSUMIDOR_FINAL_RE.test(name.trim());
}

const DIGITS_RE = /\D+/g;

export function normalizeWhatsapp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(DIGITS_RE, '');
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }
  return digits;
}

const FACTURA_TAG_RE = /\[FACTURA\]/i;
const DOC_RE = /(?:doc|cc|nit|documento)\s*(?:[:#]\s*)?([A-Z0-9.-]{4,30})/i;
const WA_RE = /(?:wa|whatsapp|tel|cel)\s*[:#]?\s*([+\d\s().-]{7,25})/i;
// Notes use `|` as the field separator ("Cliente: NAME | Tel: PHONE || [FACTURA]
// …"), so the name must stop at the first pipe. Without it the capture swallowed
// the phone and the [FACTURA] tag straight into the stored customer name.
const NAME_RE = /(?:nombre|cliente)\s*(?:[:#]\s*)?([^\n,;|]{2,120})/i;

export type ParsedInvoiceCustomer = {
  name: string | null;
  documentId: string | null;
  whatsapp: string | null;
};

export function parseFacturaCustomer(
  notes: string | null | undefined,
): ParsedInvoiceCustomer | null {
  if (!notes || !FACTURA_TAG_RE.test(notes)) {
    return null;
  }

  const docMatch = notes.match(DOC_RE);
  const waMatch = notes.match(WA_RE);
  const nameMatch = notes.match(NAME_RE);

  const documentId = docMatch?.[1]?.trim() ?? null;
  const whatsapp = normalizeWhatsapp(waMatch?.[1] ?? null);
  const name = nameMatch?.[1]?.trim() ?? null;

  if (!documentId && !whatsapp) {
    return null;
  }

  if (name && isConsumidorFinal(name)) {
    return null;
  }

  return { name, documentId, whatsapp };
}
