'use server';

import type { EmitOutcome } from '@/libs/einvoice/emit';
import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/DB';
import { loadEInvoiceConfig } from '@/libs/einvoice/config';
import {
  emitInvoiceForSale,

  parseInvoiceNotes,
} from '@/libs/einvoice/emit';
import { FactusAdapter } from '@/libs/einvoice/factus-adapter';
import { salesSchema } from '@/models/Schema';

export type InvoiceTab = 'all' | 'pending' | 'emitted' | 'error';

export type InvoiceRow = {
  id: string;
  saleNumber: number | null;
  createdAt: string;
  total: number;
  paymentType: string | null;
  einvoiceStatus: string | null;
  einvoiceCufe: string | null;
  einvoiceNumber: string | null;
  client: {
    name: string | null;
    doc: string | null;
    whatsapp: string | null;
    email: string | null;
    address: string | null;
    consumidorFinal: boolean;
  };
};

export type InvoicesPayload = {
  items: InvoiceRow[];
  stats: { pending: number; emitted: number; error: number };
  configured: boolean;
};

export type TestConnectionResult
  = | { ok: true; env: string; baseUrl: string }
    | { ok: false; message: string };

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage e-invoicing');
  }
  return { userId, orgId };
}

const LIST_LIMIT = 200;

// Status sets the tabs filter by. The latest invoice mirror on `sales` uses
// 'failed'; historical rows may carry 'error' — treat both as the error tab.
const STATUS_FILTER: Record<Exclude<InvoiceTab, 'all'>, string[]> = {
  pending: ['pending'],
  emitted: ['emitted'],
  error: ['error', 'failed'],
};

/**
 * Unified Facturas view: sales grouped by e-invoice status. Stats are computed
 * across ALL statuses (a separate grouped count) so every tab badge is accurate
 * regardless of which tab is currently selected.
 */
export async function listInvoices(
  tab: InvoiceTab = 'pending',
): Promise<InvoicesPayload> {
  const { orgId } = await requireOrg();

  const statusList
    = tab === 'all'
      ? ['pending', 'emitted', 'error', 'failed']
      : (STATUS_FILTER[tab] ?? ['pending']);

  const [config, rows, statRows] = await Promise.all([
    loadEInvoiceConfig(orgId),
    db
      .select({
        id: salesSchema.id,
        saleNumber: salesSchema.saleNumber,
        createdAt: salesSchema.createdAt,
        total: salesSchema.total,
        paymentType: salesSchema.paymentType,
        notes: salesSchema.notes,
        einvoiceStatus: salesSchema.einvoiceStatus,
        einvoiceCufe: salesSchema.einvoiceCufe,
        einvoiceNumber: salesSchema.einvoiceNumber,
      })
      .from(salesSchema)
      .where(
        and(
          eq(salesSchema.organizationId, orgId),
          inArray(salesSchema.einvoiceStatus, statusList),
        ),
      )
      .orderBy(desc(salesSchema.createdAt))
      .limit(LIST_LIMIT),
    db
      .select({
        status: salesSchema.einvoiceStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(salesSchema)
      .where(eq(salesSchema.organizationId, orgId))
      .groupBy(salesSchema.einvoiceStatus),
  ]);

  const stats = { pending: 0, emitted: 0, error: 0 };
  for (const r of statRows) {
    if (r.status === 'emitted') {
      stats.emitted += r.count;
    } else if (r.status === 'error' || r.status === 'failed') {
      stats.error += r.count;
    } else if (r.status === 'pending') {
      stats.pending += r.count;
    }
  }

  const items: InvoiceRow[] = rows.map((s) => {
    const parsed = parseInvoiceNotes(s.notes);
    const isFinal = parsed.consumidorFinal;
    return {
      id: s.id,
      saleNumber: s.saleNumber,
      createdAt: s.createdAt.toISOString(),
      total: Number(s.total ?? 0),
      paymentType: s.paymentType,
      einvoiceStatus: s.einvoiceStatus,
      einvoiceCufe: s.einvoiceCufe,
      einvoiceNumber: s.einvoiceNumber,
      client: {
        name: isFinal ? 'Consumidor Final' : (parsed.name ?? null),
        doc: isFinal ? null : (parsed.documentId ?? null),
        whatsapp: isFinal ? null : (parsed.whatsapp ?? null),
        email: isFinal ? null : (parsed.email ?? null),
        address: isFinal ? null : (parsed.address ?? null),
        consumidorFinal: isFinal,
      },
    };
  });

  return { items, stats, configured: config.configured };
}

/** Manual emit / retry from the Facturas module. */
export async function emitInvoice(
  saleId: string,
  force = false,
): Promise<EmitOutcome> {
  const { userId, orgId } = await requireOrg();
  const result = await emitInvoiceForSale(orgId, saleId, { force, actor: userId });
  revalidatePath('/dashboard/facturas');
  return result;
}

/** Verifies the saved Factus credentials by requesting an OAuth token. */
export async function testEInvoiceConnection(): Promise<TestConnectionResult> {
  const { orgId } = await requireAdminOrg();
  const cfg = await loadEInvoiceConfig(orgId);
  if (cfg.provider !== 'factus') {
    return { ok: false, message: 'El proveedor seleccionado no es Factus.' };
  }
  if (!cfg.configured) {
    return {
      ok: false,
      message: 'Faltan credenciales (email, password, client_id, client_secret).',
    };
  }
  try {
    await FactusAdapter.accessToken(cfg);
    return { ok: true, env: cfg.factus.env, baseUrl: cfg.factus.baseUrl };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Error de conexión' };
  }
}
