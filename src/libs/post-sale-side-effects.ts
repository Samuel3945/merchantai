import type { AuditActor } from '@/libs/audit-log';
import { and, eq } from 'drizzle-orm';
import { applyInvoiceCustomerUpsert } from '@/features/customers/post-sale-hook';
import { logAction } from '@/libs/audit-log';
import { recordCashMovement } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { maybeAutoEmitInvoice } from '@/libs/einvoice/emit';
import { recordSaleTransferReconciliations } from '@/libs/transfer-reconciliation';
import { auditLogsSchema } from '@/models/Schema';

// Post-commit side effects for a sale, shared by the create path AND the deduped
// retry path of /api/pos/sales and /api/pos/sync.
//
// THE CONTRACT: for a given sale_id, exactly ONE cash_movement and ONE set of
// side effects, regardless of which request finishes them. The deduped path
// returns the existing sale but must still run this routine so a retry COMPLETES
// any side effect the original never finished (e.g. it died between the sale
// commit and recordCashMovement → cash for a real sale never recorded → drawer
// shortage at close).
//
// Each effect is idempotent by sale_id:
//   • recordCashMovement              → guards on an existing (org,sale,type=sale)
//                                        cash_movements row before inserting.
//   • recordSaleTransferReconciliations → onConflictDoNothing on UNIQUE(sale_payment).
//   • maybeAutoEmitInvoice            → emitInvoiceForSale no-ops an already-emitted
//                                        invoice.
//   • applyInvoiceCustomerUpsert      → the ONLY non-idempotent effect (it bumps
//                                        customers.totalSpent every call), so it is
//                                        gated below behind the audit-log sentinel.
//
// FIFO invariant: this routine NEVER touches stock or emits a stock movement —
// stock lives entirely inside the sale transaction. A deduped retry therefore
// can never re-decrement stock or re-emit a FIFO exit.

export type PostSaleSideEffectArgs = {
  organizationId: string;
  saleId: string;
  total: string | number;
  notes: string | null;
  // recordCashMovement / customer upsert attribution.
  userId: string;
  createdBy: string | null;
  posTokenId?: string | null;
  // Audit trail. The audit `sale.created` row is the universal "side effects
  // already applied" sentinel — it exists for every sale regardless of payment
  // method (cash, fiado, transfer), so it gates the non-idempotent customer
  // upsert even when there is no cash movement.
  audit: {
    actor: AuditActor;
    action: string;
    after?: unknown;
    metadata?: Record<string, unknown> | null;
    ip?: string | null;
    userAgent?: string | null;
  };
};

async function saleSideEffectsAlreadyApplied(
  organizationId: string,
  saleId: string,
  action: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLogsSchema.id })
    .from(auditLogsSchema)
    .where(
      and(
        eq(auditLogsSchema.organizationId, organizationId),
        eq(auditLogsSchema.entityType, 'sale'),
        eq(auditLogsSchema.entityId, saleId),
        eq(auditLogsSchema.action, action),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function applyPostSaleSideEffects(
  args: PostSaleSideEffectArgs,
): Promise<void> {
  // The audit row is written LAST, so its presence means a previous run already
  // completed every effect (including the non-idempotent customer upsert).
  const alreadyApplied = await saleSideEffectsAlreadyApplied(
    args.organizationId,
    args.saleId,
    args.audit.action,
  ).catch(() => false);

  await recordCashMovement(args.saleId, args.total, {
    organizationId: args.organizationId,
    userId: args.userId,
    posTokenId: args.posTokenId,
  }).catch(() => null);

  await recordSaleTransferReconciliations(args.saleId).catch(() => null);

  // Non-idempotent: only on the first convergence. A deduped retry whose
  // original already booked the customer must NOT bump totalSpent again.
  if (!alreadyApplied) {
    await applyInvoiceCustomerUpsert({
      organizationId: args.organizationId,
      notes: args.notes,
      total: args.total,
      createdBy: args.createdBy,
    }).catch(() => null);
  }

  // Best-effort: emit the electronic invoice if a provider is configured. Not
  // awaited — a failed emission leaves the sale retriable in Facturas.
  void maybeAutoEmitInvoice(args.organizationId, args.saleId);

  // Write the sentinel last. Idempotent enough for the audit trail: a duplicate
  // sale.created row is harmless (append-only log) and the gate above already
  // prevented the only harmful double-application (customer spend).
  if (!alreadyApplied) {
    await logAction({
      organizationId: args.organizationId,
      actor: args.audit.actor,
      action: args.audit.action,
      entityType: 'sale',
      entityId: args.saleId,
      after: args.audit.after,
      metadata: args.audit.metadata,
      ip: args.audit.ip,
      userAgent: args.audit.userAgent,
    });
  }
}
