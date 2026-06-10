import type { FactusCustomer, FactusItem } from './factus-adapter';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import {
  einvoiceEmissionsSchema,
  saleItemsSchema,
  salesSchema,
} from '@/models/Schema';
import { loadEInvoiceConfig } from './config';
import {
  FactusAdapter,

} from './factus-adapter';

// ── Notes parsing ───────────────────────────────────────────────────────────
// The cashier embeds invoice intent in the sale notes:
//   [FACTURA] Nombre:Ana | Doc:123 | WA:300... | Correo:a@b.co | Direccion:Cll 1
// By contract EVERY sale carries invoice intent: with no tag (or an explicit
// CONSUMIDOR_FINAL) we bill to "Consumidor final", so every sale can be emitted
// and shows up in the Facturas module.

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

function buildFactusCustomer(parsed: ParsedInvoiceCustomer): FactusCustomer {
  if (parsed.consumidorFinal) {
    return {
      identification: '222222222222',
      dv: '7',
      company: 'Consumidor final',
      trade_name: 'Consumidor final',
      names: 'Consumidor final',
      address: 'No aplica',
      email: 'consumidorfinal@no-aplica.co',
      phone: '0000000000',
      legal_organization_id: '2',
      tribute_id: '21',
      identification_document_id: '7', // 7 = "no identificado"
      municipality_id: 1,
    };
  }
  const name = parsed.name ?? 'Cliente';
  return {
    identification: parsed.documentId ?? '222222222222',
    company: name,
    trade_name: name,
    names: name,
    address: parsed.address ?? 'No aplica',
    email: parsed.email ?? 'sin@correo.co',
    phone: parsed.whatsapp ?? '0000000000',
    legal_organization_id: '2',
    tribute_id: '21',
    identification_document_id: '3', // 3 = cédula de ciudadanía
    municipality_id: 1,
  };
}

async function buildInvoicePayloadForSale(
  organizationId: string,
  saleId: string,
  parsed: ParsedInvoiceCustomer,
) {
  const [sale] = await db
    .select({ id: salesSchema.id, notes: salesSchema.notes })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, saleId),
        eq(salesSchema.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!sale) {
    throw new Error('Venta no encontrada');
  }

  const items = await db
    .select({
      productId: saleItemsSchema.productId,
      productName: saleItemsSchema.productName,
      qty: saleItemsSchema.qty,
      price: saleItemsSchema.price,
    })
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, saleId));
  if (items.length === 0) {
    throw new Error('Venta sin items');
  }

  const billingItems: FactusItem[] = items.map(it => ({
    code_reference: it.productId,
    name: it.productName,
    quantity: Number(it.qty),
    discount_rate: 0,
    price: Number(it.price),
    tribute_id: 1, // IVA 0 by default — basic-basket store products.
    unit_measure_id: 70, // "unidad"
    standard_code_id: 1,
    is_excluded: 1,
    tributes: [],
  }));

  return FactusAdapter.buildInvoicePayload({
    referenceCode: String(sale.id),
    observation: sale.notes ?? '',
    customer: buildFactusCustomer(parsed),
    items: billingItems,
  });
}

// ── Emission ────────────────────────────────────────────────────────────────

export type EmitOutcome
  = | { ok: true; idempotent?: boolean; cufe: string | null; number: string | null }
    | { ok: false; code: string; message: string };

/**
 * Emits the electronic invoice for a sale. Idempotent: an already-emitted sale
 * is a no-op unless `force` is set (used to retry after a failure). Persists the
 * full attempt to `einvoice_emissions` and mirrors the result onto the sale.
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
      message: 'Falta configurar Facturación electrónica en Ajustes → Fiscal.',
    };
  }

  const existing = await db
    .select()
    .from(einvoiceEmissionsSchema)
    .where(
      and(
        eq(einvoiceEmissionsSchema.organizationId, organizationId),
        eq(einvoiceEmissionsSchema.saleId, saleId),
        eq(einvoiceEmissionsSchema.kind, 'invoice'),
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

  // Reuse the latest failed/queued attempt instead of piling up rows.
  const reusable = existing.find(
    e => e.status === 'failed' || e.status === 'queued',
  );
  let emissionId: string;
  if (reusable) {
    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'sent',
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
        kind: 'invoice',
        provider: cfg.provider,
        status: 'sent',
        customer: parsed,
        attempts: 1,
        createdBy: opts.actor ?? 'system',
      })
      .returning({ id: einvoiceEmissionsSchema.id });
    if (!created) {
      return { ok: false, code: 'db_error', message: 'No se pudo crear la emisión.' };
    }
    emissionId = created.id;
  }

  try {
    const payload = await buildInvoicePayloadForSale(
      organizationId,
      saleId,
      parsed,
    );
    const result = await FactusAdapter.emitInvoice(cfg, payload);

    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'emitted',
        providerId: result.providerId,
        cufe: result.cufe,
        number: result.number,
        payload,
        response: result.raw,
        emittedAt: new Date(),
      })
      .where(eq(einvoiceEmissionsSchema.id, emissionId));

    await db
      .update(salesSchema)
      .set({
        einvoiceStatus: 'emitted',
        einvoiceCufe: result.cufe,
        einvoiceNumber: result.number,
        einvoiceId: emissionId,
      })
      .where(
        and(
          eq(salesSchema.id, saleId),
          eq(salesSchema.organizationId, organizationId),
        ),
      );

    return { ok: true, cufe: result.cufe, number: result.number };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Error emitiendo factura';
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
 * Emits a credit note (nota crédito) that voids an already-emitted invoice when
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
    .select({ cufe: salesSchema.einvoiceCufe })
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
      message: 'La venta no tiene CUFE; no hay factura que anular.',
    };
  }

  const items = await db
    .select({
      productId: saleItemsSchema.productId,
      productName: saleItemsSchema.productName,
      qty: saleItemsSchema.qty,
      price: saleItemsSchema.price,
    })
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, saleId));

  const noteItems = items.map(it => ({
    code_reference: it.productId,
    name: it.productName,
    quantity: Number(it.qty),
    price: Number(it.price),
  }));

  const [created] = await db
    .insert(einvoiceEmissionsSchema)
    .values({
      organizationId,
      saleId,
      kind: 'credit_note',
      provider: cfg.provider,
      status: 'sent',
      attempts: 1,
      createdBy: opts.actor ?? 'system',
    })
    .returning({ id: einvoiceEmissionsSchema.id });
  if (!created) {
    return { ok: false, code: 'db_error', message: 'No se pudo crear la NCE.' };
  }

  try {
    const result = await FactusAdapter.emitCreditNote(cfg, {
      originalCufe: sale.cufe,
      items: noteItems,
      observation: opts.reason ?? 'Devolución',
    });
    await db
      .update(einvoiceEmissionsSchema)
      .set({
        status: 'emitted',
        providerId: result.providerId,
        cufe: result.cufe,
        number: result.number,
        response: result.raw,
        emittedAt: new Date(),
      })
      .where(eq(einvoiceEmissionsSchema.id, created.id));
    return { ok: true, cufe: result.cufe, number: result.number };
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

/** Fire-and-forget invoice emission right after a sale, only when configured. */
export async function maybeAutoEmitInvoice(
  organizationId: string,
  saleId: string,
): Promise<void> {
  try {
    const cfg = await loadEInvoiceConfig(organizationId);
    if (!cfg.configured) {
      return;
    }
    await emitInvoiceForSale(organizationId, saleId, { actor: 'system' });
  } catch {
    // Best-effort: the sale already succeeded. The invoice stays 'pending'
    // (or 'failed') and can be retried from the Facturas module.
  }
}

/** Fire-and-forget credit note after a return voids an emitted invoice. */
export async function maybeEmitCreditNote(
  organizationId: string,
  saleId: string,
  reason?: string,
): Promise<void> {
  try {
    const cfg = await loadEInvoiceConfig(organizationId);
    if (!cfg.configured) {
      return;
    }
    await emitCreditNoteForSale(organizationId, saleId, { reason, actor: 'system' });
  } catch {
    // Best-effort: the return already succeeded.
  }
}
