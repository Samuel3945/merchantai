import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { customersSchema } from '@/models/Schema';
import {
  isConsumidorFinal,
  normalizeWhatsapp,
  parseFacturaCustomer,
} from './validation';

// Either the pooled db or an open transaction handle, so the (non-idempotent)
// totalSpent bump can run inside the post-sale convergence lock.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type PostSaleArgs = {
  organizationId: string;
  notes: string | null | undefined;
  total: string | number;
  createdBy?: string | null;
  // Optional executor. Defaults to the pooled db (back-compat). Pass a tx to run
  // inside an open transaction (post-sale convergence serializes on a row lock).
  executor?: Executor;
};

function toAmount(v: string | number): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

export async function applyInvoiceCustomerUpsert(args: PostSaleArgs) {
  const executor = args.executor ?? db;
  const parsed = parseFacturaCustomer(args.notes);
  if (!parsed) {
    return null;
  }
  if (parsed.name && isConsumidorFinal(parsed.name)) {
    return null;
  }

  const amount = toAmount(args.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const amountStr = amount.toFixed(2);

  const whatsapp = normalizeWhatsapp(parsed.whatsapp);
  const documentId = parsed.documentId?.trim() || null;
  if (!documentId && !whatsapp) {
    return null;
  }

  const displayName = parsed.name?.trim() || 'Cliente Factura';

  // Try to find by documentId first, then by whatsapp.
  let existingId: string | null = null;
  if (documentId) {
    const [row] = await executor
      .select({ id: customersSchema.id })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, args.organizationId),
          eq(customersSchema.documentId, documentId),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);
    existingId = row?.id ?? null;
  }
  if (!existingId && whatsapp) {
    const [row] = await executor
      .select({ id: customersSchema.id })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, args.organizationId),
          eq(customersSchema.whatsapp, whatsapp),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);
    existingId = row?.id ?? null;
  }

  if (existingId) {
    const [row] = await executor
      .update(customersSchema)
      .set({
        totalSpent: sql`${customersSchema.totalSpent} + ${amountStr}::numeric`,
        lastPurchaseAt: new Date(),
        ...(documentId ? { documentId } : {}),
        ...(whatsapp ? { whatsapp } : {}),
      })
      .where(eq(customersSchema.id, existingId))
      .returning({ id: customersSchema.id });
    return row ?? null;
  }

  const [row] = await executor
    .insert(customersSchema)
    .values({
      organizationId: args.organizationId,
      name: displayName,
      documentId,
      whatsapp,
      totalSpent: amountStr,
      lastPurchaseAt: new Date(),
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: customersSchema.id });
  return row ?? null;
}
