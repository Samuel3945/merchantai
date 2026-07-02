import type {
  MatiasCreditNotePayload,
  MatiasCustomer,
  MatiasDocumentPayload,
  MatiasLine,
  MatiasTaxTotal,
} from './matias-adapter';
import { and, desc, eq } from 'drizzle-orm';
import { consumeCreditForOrg } from '@/actions/plans';
import { db } from '@/libs/DB';
import {
  einvoiceEmissionsSchema,
  saleItemsSchema,
  salesSchema,
} from '@/models/Schema';
import { loadEInvoiceConfig } from './config';
import { MatiasAdapter } from './matias-adapter';

// ── Notes parsing ───────────────────────────────────────────────────────────
// The cashier embeds invoice intent in the sale notes:
//   [FACTURA] Nombre:Ana | Doc:123 | WA:300... | Correo:a@b.co | Direccion:Cll 1
// By contract EVERY sale carries invoice intent: with no tag (or an explicit
// CONSUMIDOR_FINAL) we emit a POS electronic document to "Consumidor final"; with
// an identified customer we emit a full electronic invoice. Either way every sale
// can be emitted and shows up in the Facturas module.

export type ParsedInvoiceCustomer = {
  consumidorFinal: boolean;
  name?: string;
  documentId?: string;
  whatsapp?: string;
  email?: string;
  address?: string;
};

const FACTURA_RE = /\[FACTURA\]\s*([^\n]+)/i;

export function parseInvoiceNotes(
  notes: string | null | undefined,
): ParsedInvoiceCustomer {
  if (!notes) {
    return { consumidorFinal: true };
  }
  const match = notes.match(FACTURA_RE);
  if (!match) {
    return { consumidorFinal: true };
  }
  const body = match[1] ?? '';
  if (/CONSUMIDOR_FINAL/i.test(body)) {
    return { consumidorFinal: true };
  }

  const out: ParsedInvoiceCustomer = { consumidorFinal: false };
  for (const part of body.split('|')) {
    const [rawKey, ...rest] = part.split(':');
    if (!rawKey || rest.length === 0) {
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (!value) {
      continue;
    }
    if (key === 'wa' || key === 'tel' || key === 'whatsapp') {
      out.whatsapp = value;
    } else if (key === 'nombre' || key === 'cliente') {
      out.name = value;
    } else if (key === 'doc' || key === 'cedula' || key === 'cédula' || key === 'nit') {
      out.documentId = value;
    } else if (key === 'correo' || key === 'email') {
      out.email = value;
    } else if (key === 'direccion' || key === 'dirección') {
      out.address = value;
    }
  }
  // Nothing identifiable → treat as final consumer so we never emit a blank one.
  if (!out.name && !out.documentId && !out.whatsapp) {
    return { consumidorFinal: true };
  }
  return out;
}

// ── Payload building ────────────────────────────────────────────────────────
//
// Catalog ids below (country/city/identity/organization/tax) follow MATIAS' public
// DIAN tables. They are seeded with the values from the official JSON examples and
// MUST be validated against the sandbox (GET public tables) on the first real
// emission. Basic-basket stores sell IVA-excluded goods, so lines default to 0%;
// when per-product IVA is added to the catalog this is where it gets wired.

const COLOMBIA_COUNTRY_ID = '170';
const DEFAULT_CITY_ID = '149'; // Medellín in MATIAS' table; per-tenant override TODO.

function money(n: number): string {
  return n.toFixed(2);
}

function buildMatiasCustomer(parsed: ParsedInvoiceCustomer): MatiasCustomer {
  const name = parsed.name ?? 'Cliente';
  return {
    country_id: COLOMBIA_COUNTRY_ID,
    city_id: DEFAULT_CITY_ID,
    identity_document_id: '3', // 3 = cédula de ciudadanía
    type_organization_id: 2, // 2 = persona natural
    tax_regime_id: 2,
    tax_level_id: 5, // No responsable de IVA
    company_name: name,
    dni: parsed.documentId ?? '222222222222',
    mobile: parsed.whatsapp ?? '0000000000',
    email: parsed.email ?? 'sin@correo.co',
    address: parsed.address ?? 'No aplica',
    postal_code: '000000',
  };
}

type SaleItem = {
  productId: string;
  productName: string;
  qty: number | string;
  price: number | string;
};

/** Maps sale items to MATIAS lines. IVA-excluded (0%) by default — see header. */
function buildMatiasLines(items: SaleItem[]): {
  lines: MatiasLine[];
  subtotal: number;
} {
  let subtotal = 0;
  const lines = items.map((it) => {
    const qty = Number(it.qty);
    const price = Number(it.price);
    const lineAmount = qty * price;
    subtotal += lineAmount;
    const tax: MatiasTaxTotal = {
      tax_id: '1', // IVA
      tax_amount: 0,
      taxable_amount: lineAmount,
      percent: 0,
    };
    return {
      invoiced_quantity: String(qty),
      quantity_units_id: '1093', // unidad
      line_extension_amount: money(lineAmount),
      free_of_charge_indicator: false,
      description: it.productName,
      code: it.productId,
      type_item_identifications_id: '4',
      reference_price_id: '1',
      price_amount: money(price),
      base_quantity: String(qty),
      tax_totals: [tax],
    } satisfies MatiasLine;
  });
  return { lines, subtotal };
}

function buildTotals(subtotal: number): MatiasDocumentPayload['legal_monetary_totals'] {
  return {
    line_extension_amount: money(subtotal),
    tax_exclusive_amount: money(subtotal),
    tax_inclusive_amount: money(subtotal),
    payable_amount: Number(money(subtotal)),
  };
}

async function loadSaleItems(saleId: string): Promise<SaleItem[]> {
  return db
    .select({
      productId: saleItemsSchema.productId,
      productName: saleItemsSchema.productName,
      qty: saleItemsSchema.qty,
      price: saleItemsSchema.price,
    })
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, saleId));
}

async function buildDocumentForSale(
  cfg: Awaited<ReturnType<typeof loadEInvoiceConfig>>,
  saleId: string,
  parsed: ParsedInvoiceCustomer,
): Promise<{ payload: MatiasDocumentPayload; isPos: boolean }> {
  const items = await loadSaleItems(saleId);
  if (items.length === 0) {
    throw new Error('La venta no tiene productos.');
  }
  const { lines, subtotal } = buildMatiasLines(items);
  const totals = buildTotals(subtotal);
  const tax_totals: MatiasTaxTotal[] = [
    { tax_id: '1', tax_amount: 0, taxable_amount: subtotal, percent: 0 },
  ];

  const base: MatiasDocumentPayload = {
    resolution_number: cfg.resolutionNumber ?? '',
    prefix: cfg.prefix ?? '',
    notes: '',
    operation_type_id: 1,
    type_document_id: 7,
    graphic_representation: 1, // generate the PDF
    send_email: parsed.email ? 1 : 0,
    document_signature: { cashier: 'Cajero', seller: 'MerchantAI' },
    payments: [
      { payment_method_id: 1, means_payment_id: 10, value_paid: money(subtotal) },
    ],
    lines,
    legal_monetary_totals: totals,
    tax_totals,
  };

  // Final consumer → POS electronic document (documento equivalente, type 20).
  if (parsed.consumidorFinal) {
    return {
      isPos: true,
      payload: {
        ...base,
        type_document_id: 20,
        point_of_sale: {
          cashier_name: 'Cajero',
          terminal_number: 'POS01',
          cashier_type: 'Caja principal',
          sales_code: 'POS01',
          address: 'Punto de venta',
          sub_total: money(subtotal),
        },
        software_manufacturer: {
          owner_name: 'MerchantAI',
          company_name: 'MerchantAI',
          software_name: 'MerchantAI POS',
        },
      },
    };
  }

  // Identified customer → full electronic invoice (type 7).
  return {
    isPos: false,
    payload: { ...base, customer: buildMatiasCustomer(parsed) },
  };
}

// ── Emission ────────────────────────────────────────────────────────────────

export type EmitOutcome
  = | { ok: true; idempotent?: boolean; cufe: string | null; number: string | null }
    | { ok: false; code: string; message: string };

/**
 * Emits the electronic document for a sale (POS doc for final consumer, full
 * invoice for an identified customer). Idempotent: an already-emitted sale is a
 * no-op unless `force` is set. Persists the full attempt to `einvoice_emissions`
 * and mirrors the result onto the sale.
 */
export async function emitInvoiceForSale(
  organizationId: string,
  saleId: string,
  opts: { force?: boolean; actor?: string } = {},
): Promise<EmitOutcome> {
  const cfg = await loadEInvoiceConfig(organizationId);
  if (!cfg.configured) {
    return {
      ok: false,
      code: 'not_configured',
      message: 'Falta configurar la facturación electrónica en Ajustes → Fiscal.',
    };
  }

  const existing = await db
    .select()
    .from(einvoiceEmissionsSchema)
    .where(
      and(
        eq(einvoiceEmissionsSchema.organizationId, organizationId),
        eq(einvoiceEmissionsSchema.saleId, saleId),
      ),
    )
    .orderBy(desc(einvoiceEmissionsSchema.createdAt));

  const successful = existing.find(e => e.status === 'emitted');
  if (successful && !opts.force) {
    return {
      ok: true,
      idempotent: true,
      cufe: successful.cufe,
      number: successful.number,
    };
  }

  const [sale] = await db
    .select({ notes: salesSchema.notes })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, saleId),
        eq(salesSchema.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!sale) {
    return { ok: false, code: 'not_found', message: 'Venta no encontrada.' };
  }

  const parsed = parseInvoiceNotes(sale.notes);
  const kind = parsed.consumidorFinal ? 'pos' : 'invoice';

  // Reuse the latest failed/queued attempt instead of piling up rows.
  const reusable = existing.find(
    e => e.status === 'failed' || e.status === 'queued',
  );

  // A fresh document consumes 1 credit (same model as AI actions). Block BEFORE
  // calling MATIAS so we never emit a DIAN document the tenant can't pay for. A
  // retry of an already-charged failed attempt does not consume again.
  if (!reusable) {
    const credit = await consumeCreditForOrg(organizationId);
    if (!credit.success) {
      return {
        ok: false,
        code: 'no_credits',
        message:
          'No te quedan créditos de facturación. Recargá para seguir emitiendo.',
      };
    }
  }

  let emissionId: string;
  if (reusable) {
    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'sent',
        kind,
        attempts: (reusable.attempts ?? 0) + 1,
        lastError: null,
      })
      .where(eq(einvoiceEmissionsSchema.id, reusable.id));
    emissionId = reusable.id;
  } else {
    const [created] = await db
      .insert(einvoiceEmissionsSchema)
      .values({
        organizationId,
        saleId,
        kind,
        provider: cfg.provider,
        status: 'sent',
        customer: parsed,
        attempts: 1,
        creditsConsumed: 1,
        createdBy: opts.actor ?? 'system',
      })
      .returning({ id: einvoiceEmissionsSchema.id });
    if (!created) {
      return { ok: false, code: 'db_error', message: 'No se pudo crear la emisión.' };
    }
    emissionId = created.id;
  }

  try {
    const { payload, isPos } = await buildDocumentForSale(cfg, saleId, parsed);
    const result = isPos
      ? await MatiasAdapter.emitPos(cfg, payload)
      : await MatiasAdapter.emitInvoice(cfg, payload);

    // A 200 with a non-"00" DIAN status is a rejection, not a success.
    if (!result.documentKey || !result.isValid) {
      const message = result.dianStatus
        ? `La DIAN rechazó el documento (estado ${result.dianStatus}).`
        : 'La DIAN no validó el documento.';
      await db
        .update(einvoiceEmissionsSchema)
        .set({ status: 'failed', lastError: message, response: result.raw })
        .where(eq(einvoiceEmissionsSchema.id, emissionId));
      await db
        .update(salesSchema)
        .set({ einvoiceStatus: 'failed' })
        .where(
          and(
            eq(salesSchema.id, saleId),
            eq(salesSchema.organizationId, organizationId),
          ),
        );
      return { ok: false, code: 'dian_rejected', message };
    }

    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'emitted',
        providerId: result.number,
        cufe: result.documentKey,
        number: result.number,
        dianStatus: result.dianStatus,
        pdfUrl: result.pdfUrl,
        xmlUrl: result.xmlUrl,
        payload,
        response: result.raw,
        emittedAt: new Date(),
      })
      .where(eq(einvoiceEmissionsSchema.id, emissionId));

    await db
      .update(salesSchema)
      .set({
        einvoiceStatus: 'emitted',
        einvoiceCufe: result.documentKey,
        einvoiceNumber: result.number,
        einvoiceId: emissionId,
      })
      .where(
        and(
          eq(salesSchema.id, saleId),
          eq(salesSchema.organizationId, organizationId),
        ),
      );

    return { ok: true, cufe: result.documentKey, number: result.number };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Error emitiendo el documento';
    const body = (e as { body?: unknown })?.body ?? null;
    await db
      .update(einvoiceEmissionsSchema)
      .set({ status: 'failed', lastError: message, response: body })
      .where(eq(einvoiceEmissionsSchema.id, emissionId));
    await db
      .update(salesSchema)
      .set({ einvoiceStatus: 'failed' })
      .where(
        and(
          eq(salesSchema.id, saleId),
          eq(salesSchema.organizationId, organizationId),
        ),
      );
    return { ok: false, code: 'emit_failed', message };
  }
}

/**
 * Emits a credit note (nota crédito) that voids an already-emitted document when
 * the sale is returned. No-op when the sale has no CUFE (it was never emitted).
 */
export async function emitCreditNoteForSale(
  organizationId: string,
  saleId: string,
  opts: { reason?: string; actor?: string } = {},
): Promise<EmitOutcome> {
  const cfg = await loadEInvoiceConfig(organizationId);
  if (!cfg.configured) {
    return { ok: false, code: 'not_configured', message: 'FE no configurada.' };
  }

  const [sale] = await db
    .select({
      cufe: salesSchema.einvoiceCufe,
      number: salesSchema.einvoiceNumber,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, saleId),
        eq(salesSchema.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!sale?.cufe) {
    return {
      ok: false,
      code: 'no_cufe',
      message: 'La venta no tiene CUFE; no hay documento que anular.',
    };
  }

  const items = await loadSaleItems(saleId);
  const { lines, subtotal } = buildMatiasLines(items);
  const totals = buildTotals(subtotal);

  // A credit note is its own billable document → consume 1 credit.
  const credit = await consumeCreditForOrg(organizationId);
  if (!credit.success) {
    return {
      ok: false,
      code: 'no_credits',
      message:
        'No te quedan créditos de facturación. Recargá para emitir la nota crédito.',
    };
  }

  const [created] = await db
    .insert(einvoiceEmissionsSchema)
    .values({
      organizationId,
      saleId,
      kind: 'credit_note',
      provider: cfg.provider,
      status: 'sent',
      attempts: 1,
      creditsConsumed: 1,
      createdBy: opts.actor ?? 'system',
    })
    .returning({ id: einvoiceEmissionsSchema.id });
  if (!created) {
    return { ok: false, code: 'db_error', message: 'No se pudo crear la NCE.' };
  }

  const payload: MatiasCreditNotePayload = {
    resolution_number: cfg.resolutionNumber ?? '',
    prefix: cfg.prefix ?? '',
    notes: opts.reason ?? 'Devolución',
    operation_type_id: 12,
    type_document_id: 5,
    graphic_representation: 1,
    send_email: 0,
    discrepancy_response: { reference_id: sale.number ?? '', response_id: '2' },
    billing_reference: {
      number: sale.number ?? '',
      date: new Date().toISOString().slice(0, 10),
      uuid: sale.cufe,
    },
    payments: [
      { payment_method_id: 1, means_payment_id: 10, value_paid: money(subtotal) },
    ],
    lines,
    legal_monetary_totals: totals,
    tax_totals: [
      { tax_id: '1', tax_amount: 0, taxable_amount: subtotal, percent: 0 },
    ],
  };

  try {
    const result = await MatiasAdapter.emitCreditNote(cfg, payload);
    if (!result.documentKey || !result.isValid) {
      const message = 'La DIAN rechazó la nota crédito.';
      await db
        .update(einvoiceEmissionsSchema)
        .set({ status: 'failed', lastError: message, response: result.raw })
        .where(eq(einvoiceEmissionsSchema.id, created.id));
      return { ok: false, code: 'dian_rejected', message };
    }
    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'emitted',
        providerId: result.number,
        cufe: result.documentKey,
        number: result.number,
        dianStatus: result.dianStatus,
        pdfUrl: result.pdfUrl,
        xmlUrl: result.xmlUrl,
        payload,
        response: result.raw,
        emittedAt: new Date(),
      })
      .where(eq(einvoiceEmissionsSchema.id, created.id));
    return { ok: true, cufe: result.documentKey, number: result.number };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Error emitiendo NCE';
    const body = (e as { body?: unknown })?.body ?? null;
    await db
      .update(einvoiceEmissionsSchema)
      .set({ status: 'failed', lastError: message, response: body })
      .where(eq(einvoiceEmissionsSchema.id, created.id));
    return { ok: false, code: 'credit_note_failed', message };
  }
}

// ── Best-effort hooks (never block or fail a sale/return) ────────────────────

/** Fire-and-forget emission right after a sale, only when auto-emit is on. */
export async function maybeAutoEmitInvoice(
  organizationId: string,
  saleId: string,
): Promise<void> {
  try {
    const cfg = await loadEInvoiceConfig(organizationId);
    if (!cfg.configured || !cfg.autoEmit) {
      return;
    }
    await emitInvoiceForSale(organizationId, saleId, { actor: 'system' });
  } catch {
    // Best-effort: the sale already succeeded. The document stays 'pending'
    // (or 'failed') and can be retried from the Facturas module.
  }
}

/** Fire-and-forget credit note after a return voids an emitted document. */
export async function maybeEmitCreditNote(
  organizationId: string,
  saleId: string,
  reason?: string,
): Promise<void> {
  try {
    const cfg = await loadEInvoiceConfig(organizationId);
    if (!cfg.configured || !cfg.autoEmit) {
      return;
    }
    await emitCreditNoteForSale(organizationId, saleId, { reason, actor: 'system' });
  } catch {
    // Best-effort: the return already succeeded.
  }
}
