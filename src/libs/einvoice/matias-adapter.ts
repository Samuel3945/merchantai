/**
 * MerchantAI — Copyright (c) 2026 Samuel Alzate Tejada. Todos los derechos reservados.
 * Software propietario y confidencial. Ver LICENSE. Prohibida su copia o uso no autorizado.
 */
import type { EInvoiceConfig } from './config';

// MATIAS adapter — the ONLY module that knows MATIAS' HTTP contract.
//
// MATIAS API (https://docs.matias-api.com) is a DIAN-authorized e-invoicing
// platform built on the open-source UBL 2.1 stack. Flow:
//   1. POST /auth/login {email,password} → Bearer access_token (cached app-level).
//   2. POST /auto-increment/{invoices|pos-documents|credit-notes} with the document
//      JSON. The "auto-increment" endpoints let MATIAS resolve the consecutive
//      number + prefix from the DIAN resolution, avoiding collisions on concurrent
//      emissions — so we never track consecutives ourselves.
//
// Environment is decided ONLY by the base URL. We target the sandbox exclusively;
// the production URL is intentionally never configured.
//
// If MATIAS renames a route or a field, fix it HERE and the rest of the system
// stays untouched — that is the whole point of isolating the provider behind an
// adapter.

// ── Payload types (mirror the official JSON examples) ─────────────────────────

export type MatiasTaxTotal = {
  tax_id: string; // '1' = IVA
  tax_amount: number;
  taxable_amount: number;
  percent: number;
};

export type MatiasCustomer = {
  country_id: string;
  city_id: string;
  identity_document_id: string;
  type_organization_id: number;
  tax_regime_id: number;
  tax_level_id: number;
  company_name: string;
  dni: string;
  mobile: string;
  email: string;
  address: string;
  postal_code: string;
};

export type MatiasLine = {
  invoiced_quantity: string;
  quantity_units_id: string;
  line_extension_amount: string;
  free_of_charge_indicator: boolean;
  description: string;
  code: string;
  type_item_identifications_id: string;
  reference_price_id: string;
  price_amount: string;
  base_quantity: string;
  tax_totals: MatiasTaxTotal[];
};

export type MatiasPayment = {
  payment_method_id: number;
  means_payment_id: number;
  value_paid: string;
};

export type MatiasMonetaryTotals = {
  line_extension_amount: string;
  tax_exclusive_amount: string;
  tax_inclusive_amount: string;
  payable_amount: number;
};

export type MatiasPointOfSale = {
  cashier_name: string;
  terminal_number: string;
  cashier_type: string;
  sales_code: string;
  address: string;
  sub_total: string;
};

export type MatiasDocumentPayload = {
  resolution_number: string;
  prefix: string;
  notes?: string;
  operation_type_id: number;
  type_document_id: number; // 7 = invoice, 20 = POS
  graphic_representation: number; // 1 → generate PDF
  send_email: number;
  document_signature?: { cashier: string; seller: string };
  payments: MatiasPayment[];
  customer?: MatiasCustomer; // omitted for POS to final consumer
  lines: MatiasLine[];
  legal_monetary_totals: MatiasMonetaryTotals;
  tax_totals: MatiasTaxTotal[];
  point_of_sale?: MatiasPointOfSale;
  software_manufacturer?: {
    owner_name: string;
    company_name: string;
    software_name: string;
  };
};

export type MatiasCreditNotePayload = MatiasDocumentPayload & {
  discrepancy_response: { reference_id: string; response_id: string };
  billing_reference: { number: string; date: string; uuid: string };
};

export type MatiasEmitResult = {
  documentKey: string | null; // CUFE / CUDE
  number: string | null;
  dianStatus: string | null; // StatusCode ('00' = approved)
  isValid: boolean;
  pdfUrl: string | null;
  xmlUrl: string | null;
  qr: string | null;
  raw: unknown;
};

export type MatiasError = Error & {
  status?: number;
  code?: string;
  body?: unknown;
};

function matiasError(message: string, status: number, body: unknown): MatiasError {
  const err = new Error(message) as MatiasError;
  err.status = status;
  err.body = body;
  return err;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Looks for the first present key, checking the root and a `response`/`data`
 * envelope. Returns strings and numbers as strings, and `{ url }` nodes as the URL.
 */
function pick(json: unknown, ...keys: string[]): string | null {
  const root = asObj(json);
  const roots = [root, asObj(root?.response), asObj(root?.data)].filter(Boolean);
  for (const r of roots) {
    for (const k of keys) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) {
        return v;
      }
      if (typeof v === 'number') {
        return String(v);
      }
    }
  }
  return null;
}

function nestedUrl(json: unknown, key: string): string | null {
  const root = asObj(json);
  const node = asObj(root?.[key]);
  if (!node) {
    return null;
  }
  if (typeof node.url === 'string' && node.url) {
    return node.url;
  }
  if (typeof node.data === 'string' && node.data) {
    return node.data;
  }
  return null;
}

function parseEmitResult(json: unknown): MatiasEmitResult {
  const root = asObj(json) ?? {};
  const response = asObj(root.response) ?? root;
  const dianStatus
    = typeof response.StatusCode === 'string'
      || typeof response.StatusCode === 'number'
      ? String(response.StatusCode)
      : null;
  const isValid
    = response.IsValid === true
      || response.IsValid === 'true'
      || dianStatus === '00';
  return {
    documentKey: pick(json, 'XmlDocumentKey', 'document_key', 'cufe', 'cude', 'cune'),
    number: pick(json, 'XmlFileName', 'number', 'document_number'),
    dianStatus,
    isValid,
    pdfUrl: nestedUrl(json, 'pdf'),
    xmlUrl: nestedUrl(json, 'AttachedDocument'),
    qr: nestedUrl(json, 'qr'),
    raw: json,
  };
}

// ── Auth + token cache (app-level: ONE "Casa de Software" account) ─────────────

let tokenCache: { token: string; expiresAt: number } | null = null;

async function login(cfg: EInvoiceConfig): Promise<string> {
  if (!cfg.matias.email || !cfg.matias.password) {
    throw matiasError('Faltan las credenciales de la cuenta MATIAS.', 0, null);
  }
  const res = await fetch(`${cfg.matias.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      email: cfg.matias.email,
      password: cfg.matias.password,
    }),
  });
  const json = await parseJson(res);
  if (!res.ok) {
    const message = pick(json, 'message') ?? `MATIAS auth HTTP ${res.status}`;
    throw matiasError(message, res.status, json);
  }
  const token = pick(json, 'access_token');
  if (!token) {
    throw matiasError('MATIAS no devolvió un token de acceso.', res.status, json);
  }
  // Conservative TTL; we also re-login automatically on a 401 (see authedPost).
  tokenCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function getToken(cfg: EInvoiceConfig, force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }
  return login(cfg);
}

async function authedPost(
  cfg: EInvoiceConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  const send = (token: string): Promise<Response> =>
    fetch(`${cfg.matias.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

  let res = await send(await getToken(cfg));
  if (res.status === 401) {
    // Token expired or invalidated server-side → re-login once and retry.
    res = await send(await getToken(cfg, true));
  }

  const json = await parseJson(res);
  if (!res.ok) {
    const message
      = pick(json, 'message', 'StatusDescription') ?? `MATIAS HTTP ${res.status}`;
    throw matiasError(message, res.status, json);
  }
  return json;
}

// ── Public adapter ─────────────────────────────────────────────────────────────

export const MatiasAdapter = {
  /** Verifies the account credentials against the sandbox (used by test-connection). */
  async accessToken(cfg: EInvoiceConfig): Promise<string> {
    return getToken(cfg, true);
  },

  /** Emits an electronic invoice (type_document_id 7) via the auto-increment route. */
  async emitInvoice(
    cfg: EInvoiceConfig,
    payload: MatiasDocumentPayload,
  ): Promise<MatiasEmitResult> {
    return parseEmitResult(
      await authedPost(cfg, '/auto-increment/invoices', payload),
    );
  },

  /** Emits a POS electronic document (type_document_id 20). */
  async emitPos(
    cfg: EInvoiceConfig,
    payload: MatiasDocumentPayload,
  ): Promise<MatiasEmitResult> {
    return parseEmitResult(
      await authedPost(cfg, '/auto-increment/pos-documents', payload),
    );
  },

  /** Emits a credit note (type_document_id 5) referencing the original document. */
  async emitCreditNote(
    cfg: EInvoiceConfig,
    payload: MatiasCreditNotePayload,
  ): Promise<MatiasEmitResult> {
    return parseEmitResult(
      await authedPost(cfg, '/auto-increment/credit-notes', payload),
    );
  },
};
