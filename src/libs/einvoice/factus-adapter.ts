import type { EInvoiceConfig } from './config';

// Factus adapter — the ONLY module that knows Factus' HTTP contract.
//
// Factus (https://factus.com.co) is a DIAN-authorized e-invoicing provider. The
// flow shared by most providers is OAuth2 password grant to get a token, then a
// POST that validates+emits the document. If Factus renames a route or a field,
// fix it HERE and the rest of the system stays untouched — that is the whole
// point of isolating the provider behind an adapter.

export type FactusCustomer = {
  identification: string;
  dv?: string;
  company: string;
  trade_name: string;
  names: string;
  address: string;
  email: string;
  phone: string;
  legal_organization_id: string;
  tribute_id: string;
  identification_document_id: string;
  municipality_id: number;
};

export type FactusItem = {
  code_reference: string;
  name: string;
  quantity: number;
  discount_rate: number;
  price: number;
  tribute_id: number;
  unit_measure_id: number;
  standard_code_id: number;
  is_excluded: number;
  tributes: unknown[];
};

export type FactusInvoicePayload = {
  numbering_range_id: number;
  reference_code: string;
  observation: string;
  payment_form: string;
  payment_due_date: string | null;
  payment_method_code: string;
  billing_period: null;
  customer: FactusCustomer;
  items: FactusItem[];
};

export type FactusEmitResult = {
  providerId: string | null;
  cufe: string | null;
  number: string | null;
  raw: unknown;
};

type FactusError = Error & { status?: number; body?: unknown };

function factusError(message: string, status: number, body: unknown): FactusError {
  const err = new Error(message) as FactusError;
  err.status = status;
  err.body = body;
  return err;
}

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

function pick(obj: unknown, ...keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const record = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = record[k];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
    if (typeof v === 'number') {
      return String(v);
    }
  }
  return null;
}

export const FactusAdapter = {
  async accessToken(cfg: EInvoiceConfig): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: cfg.factus.clientId ?? '',
      client_secret: cfg.factus.clientSecret ?? '',
      username: cfg.factus.email ?? '',
      password: cfg.factus.password ?? '',
    });

    const res = await fetch(`${cfg.factus.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });

    const json = await parseJson(res);
    if (!res.ok) {
      const record = (json ?? {}) as Record<string, unknown>;
      const message
        = (typeof record.message === 'string' && record.message)
          || (typeof record.error_description === 'string'
            && record.error_description)
          || `Factus auth HTTP ${res.status}`;
      throw factusError(message, res.status, json);
    }

    const token = (json as Record<string, unknown> | null)?.access_token;
    if (typeof token !== 'string' || !token) {
      throw factusError('Factus no devolvió un token', res.status, json);
    }
    return token;
  },

  // Builds the body for POST /v1/bills/validate.
  buildInvoicePayload(args: {
    referenceCode: string;
    observation: string;
    customer: FactusCustomer;
    items: FactusItem[];
  }): FactusInvoicePayload {
    return {
      numbering_range_id: 1, // Factus uses preconfigured ranges; 1 is the sale default.
      reference_code: args.referenceCode,
      observation: args.observation,
      payment_form: '1', // contado (cash)
      payment_due_date: null,
      payment_method_code: '10',
      billing_period: null,
      customer: args.customer,
      items: args.items,
    };
  },

  async emitInvoice(
    cfg: EInvoiceConfig,
    payload: FactusInvoicePayload,
  ): Promise<FactusEmitResult> {
    const token = await this.accessToken(cfg);
    const res = await fetch(`${cfg.factus.baseUrl}/v1/bills/validate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await parseJson(res);
    if (!res.ok) {
      const message
        = pick(json, 'message') ?? `Factus emit HTTP ${res.status}`;
      throw factusError(message, res.status, json);
    }

    const data = (json as Record<string, unknown> | null)?.data as
      | Record<string, unknown>
      | undefined;
    const bill = (data?.bill ?? (json as Record<string, unknown> | null)?.bill ?? json) as unknown;
    return {
      providerId: pick(bill, 'id', 'uuid'),
      cufe: pick(bill, 'cufe', 'cude'),
      number: pick(bill, 'number', 'invoice_number'),
      raw: json,
    };
  },

  async emitCreditNote(
    cfg: EInvoiceConfig,
    args: { originalCufe: string; items: unknown[]; observation: string },
  ): Promise<FactusEmitResult> {
    const token = await this.accessToken(cfg);
    const res = await fetch(`${cfg.factus.baseUrl}/v1/credit-notes/validate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        reference_cufe: args.originalCufe,
        observation: args.observation,
        items: args.items,
      }),
    });

    const json = await parseJson(res);
    if (!res.ok) {
      const message
        = pick(json, 'message') ?? `Factus credit-note HTTP ${res.status}`;
      throw factusError(message, res.status, json);
    }

    const data = (json as Record<string, unknown> | null)?.data as
      | Record<string, unknown>
      | undefined;
    const note = (data?.credit_note
      ?? (json as Record<string, unknown> | null)?.credit_note
      ?? json) as unknown;
    return {
      providerId: pick(note, 'id'),
      cufe: pick(note, 'cufe', 'cude'),
      number: pick(note, 'number'),
      raw: json,
    };
  },
};
