import type { AuditActor } from '@/libs/audit-log';
import { and, eq, isNull } from 'drizzle-orm';
import { applyInvoiceCustomerUpsert } from '@/features/customers/post-sale-hook';
import { logAction } from '@/libs/audit-log';
import { recordCashMovement } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { maybeAutoEmitInvoice } from '@/libs/einvoice/emit';
import { logger } from '@/libs/Logger';
import { recordSaleTransferReconciliations } from '@/libs/transfer-reconciliation';
import { auditLogsSchema, salesSchema } from '@/models/Schema';

// Post-commit side effects for a sale, shared by the create path AND the deduped
// retry path of /api/pos/sales and /api/pos/sync.
//
// THE CONTRACT: for a given sale_id, AT MOST ONE cash_movement and exactly ONE
// set of the other side effects, regardless of which request finishes them —
// including a TRUE concurrent double-submit of the same idempotency key (the
// create-path winner racing the 23505-catch dedupe-path loser). The deduped path
// returns the existing sale but still runs this routine so a retry COMPLETES the
// session-agnostic effects the original never finished (customer-spend bump,
// transfer reconciliations, audit sentinel).
//
// CASH IS DIFFERENT — it is session-scoped and a sale carries no
// cash_session_id. The deduped/convergence path therefore DEDUPES the cash
// movement (never doubles it) but does NOT create a MISSING one: booking a late
// movement into "the latest open session" would credit the cash to the wrong
// arqueo window. A genuinely missing cash movement (original died before
// recordCashMovement) is logged and left for the arqueo reconciliation flow, not
// silently booked. Only the create path (isConvergenceRetry=false) books cash.
//
// HOW EXACTLY-ONCE IS GUARANTEED: all DB side effects run inside a SINGLE
// db.transaction that FIRST acquires a row lock on the sale (SELECT … FOR
// UPDATE). The second concurrent converger BLOCKS on that lock until the first
// COMMITs, then re-reads the sentinel and sees it already applied → does nothing.
// The non-atomic check-then-write is therefore serialized into exactly-once for
// the cash movement, the customer-spend bump, and the transfer reconciliations.
// Each effect keeps its own existence-guard as defense-in-depth, but correctness
// now comes from the lock, not from those guards.
//
// Each effect, ordered inside the lock:
//   • recordCashMovement              → guards on an existing (org,sale,type=sale)
//                                        cash_movements row before inserting.
//   • applyInvoiceCustomerUpsert      → the ONLY non-idempotent effect (it bumps
//                                        customers.totalSpent every call), so it is
//                                        gated by the audit-log sentinel below.
//   • recordSaleTransferReconciliations → onConflictDoNothing on UNIQUE(sale_payment).
//   • sale.created audit row          → written LAST; it is the universal "side
//                                        effects already applied" sentinel.
//
// maybeAutoEmitInvoice (a DIAN provider NETWORK call) is deliberately kept
// OUTSIDE the transaction — we must never hold a row lock across an external
// call. It stays fire-and-forget with its own per-sale guard; provider-side
// dedup of an already-emitted invoice is the backstop for the rare concurrent
// case (the accepted WARNING, not a CRITICAL).
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
  // NOTE: cash device scoping is NOT a caller input. The cash movement is scoped
  // to the PERSISTED sale.posTokenId (the device), read under the FOR UPDATE lock
  // inside applyPostSaleSideEffects. posTokenId is the DEVICE, not the session —
  // see the CASH IS DIFFERENT note in the header for why the convergence path
  // does not create a missing movement.
  // Convergence flag. The create path leaves this false (it just created the sale
  // and books cash into the open session). The deduped/retry path sets it true so
  // a missing cash movement is left for arqueo instead of booked into the wrong
  // session. Every other effect still converges on both paths.
  isConvergenceRetry?: boolean;
  // Audit trail. The audit `sale.created` row is the "side effects already
  // applied" sentinel. INVARIANT: this routine is the only writer of a
  // `sale.created` audit row for a POS sale, so the sentinel uniquely means
  // "applyPostSaleSideEffects completed for this sale". It exists for every sale
  // regardless of payment method (cash, credito, transfer), so it gates the
  // non-idempotent customer upsert even when there is no cash movement.
  audit: {
    actor: AuditActor;
    action: string;
    after?: unknown;
    metadata?: Record<string, unknown> | null;
    ip?: string | null;
    userAgent?: string | null;
  };
};

export async function applyPostSaleSideEffects(
  args: PostSaleSideEffectArgs,
): Promise<void> {
  // True only on the run that actually applies the effects (writes the sentinel).
  // A normal deduped retry finds the sentinel and skips, so it must NOT re-fire
  // the e-invoice emission below.
  let applied = false;
  // Serialize every converger of this sale on a row lock so the check-then-write
  // of the sentinel is atomic: the second concurrent request blocks here until
  // the first commits, then sees the sentinel and skips.
  await db
    .transaction(async (tx) => {
      // FOR UPDATE on the sale row. This both takes the lock AND gives us the
      // persisted posTokenId, so the cash movement scopes to the same session
      // the create path used (fix: don't derive from ctx.tokenId).
      const [locked] = await tx
        .select({
          id: salesSchema.id,
          posTokenId: salesSchema.posTokenId,
        })
        .from(salesSchema)
        .where(eq(salesSchema.id, args.saleId))
        .for('update')
        .limit(1);

      // The sale was committed before any converger runs; if it is somehow gone,
      // there is nothing to converge.
      if (!locked) {
        return;
      }

      // The audit row is written LAST, so its presence means a previous run (or
      // the converger that just released this lock) already completed every
      // effect, including the non-idempotent customer upsert. Re-running on every
      // normal retry is also avoided here: an already-converged sale does nothing.
      const [sentinel] = await tx
        .select({ id: auditLogsSchema.id })
        .from(auditLogsSchema)
        .where(
          and(
            eq(auditLogsSchema.organizationId, args.organizationId),
            eq(auditLogsSchema.entityType, 'sale'),
            eq(auditLogsSchema.entityId, args.saleId),
            eq(auditLogsSchema.action, args.audit.action),
          ),
        )
        .limit(1);
      if (sentinel) {
        return;
      }

      await recordCashMovement(args.saleId, args.total, {
        organizationId: args.organizationId,
        userId: args.userId,
        posTokenId: locked.posTokenId,
        executor: tx,
        // Convergence retries dedupe cash but never create a missing movement
        // (unknown session). Only the create path books cash.
        createIfMissing: !args.isConvergenceRetry,
      });

      // Invoice-tagged sales resolve/create their customer here (the upsert
      // returns the matched customer id). Thread it back onto the sale so the
      // customer detail (ficha de cliente) can list this purchase. Runs in the
      // same convergence lock as the upsert; only fills a NULL to stay
      // idempotent across retries. Anonymous sales get no customer → no-op.
      const upsertedCustomer = await applyInvoiceCustomerUpsert({
        organizationId: args.organizationId,
        notes: args.notes,
        total: args.total,
        createdBy: args.createdBy,
        executor: tx,
      });

      if (upsertedCustomer?.id) {
        await tx
          .update(salesSchema)
          .set({ customerId: upsertedCustomer.id })
          .where(
            and(
              eq(salesSchema.id, args.saleId),
              isNull(salesSchema.customerId),
            ),
          );
      }

      await recordSaleTransferReconciliations(args.saleId, tx);

      // Write the sentinel LAST, inside the lock, so the next FOR UPDATE acquirer
      // sees it on commit and skips. throwOnError rolls the whole convergence back
      // if the gate row can't be written, rather than committing effects ungated.
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
        executor: tx,
        throwOnError: true,
      });

      // Reached only when the sentinel was absent and every effect just ran.
      applied = true;
    })
    // A side-effect failure must NEVER roll back or fail the already-committed
    // sale. Swallow and let the next retry converge (the lock makes that safe) —
    // but LOG it first so a money-path convergence failure (cash movement,
    // customer spend, transfer reconciliation) is observable instead of silent.
    .catch((err) => {
      logger.error('post_sale_side_effects_failed', {
        organizationId: args.organizationId,
        saleId: args.saleId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

  // OUTSIDE the lock: emit the electronic invoice if a provider is configured.
  // A DIAN provider network call must never run while we hold a sale row lock.
  // Only fired on the run that actually applied the effects — a plain deduped
  // retry (sentinel already present) skips it, so a double-tap does not trigger a
  // second provider call. Not awaited — a failed emission leaves the sale
  // retriable in Facturas, and provider-side dedup is the backstop for the rare
  // concurrent case.
  if (applied) {
    void maybeAutoEmitInvoice(args.organizationId, args.saleId);
  }
}
