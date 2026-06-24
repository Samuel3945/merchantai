import { and, eq, sql } from 'drizzle-orm';
import { round2 } from '@/libs/creditos-math';
import { writeLotReturnCredit } from '@/libs/supplier-returns';
import {
  productsSchema,
  stockMovementsSchema,
  supplierPayablesSchema,
  supplierRefundsSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';

// Executor is typed as `any` to bridge Drizzle db/tx/TenantDb (same pattern as
// supplier-returns.ts). All exported function signatures are explicit.
// biome-ignore lint/suspicious/noExplicitAny: bridges Drizzle db/tx/TenantDb structural mismatch
type Executor = any;

// ── returnLot ─────────────────────────────────────────────────────────────────
//
// Executes a lot-level supplier return inside a single transaction.
//
// Algorithm (lock order: stock_movements lot → supplier_payables payable):
//   1. SELECT lot FOR UPDATE — guards concurrent returns on the same lot.
//   2. SELECT payable FOR UPDATE — gives fresh outstanding, guards concurrent payments.
//   3. Compute split:
//        returnValue   = qtyReturned × lot.unitCost  (frozen cost)
//        creditPortion = min(returnValue, outstanding)
//        refundPortion = returnValue − creditPortion
//   4. Validate: if refundPortion > 0.005 and no container → throw refund_container_required.
//   5. Consume qty from lot: UPDATE stock_movements.remaining_qty -= qtyReturned.
//   6. INSERT stock_movements exit row (reason='return_supplier').
//   7. UPDATE products.stock -= qtyReturned.
//   8. if refundPortion > 0.005:
//        INSERT treasury_movements (type='refund', from=null, to=container)
//        INSERT supplier_refunds
//   9. if creditPortion > 0.005:
//        writeLotReturnCredit(tx, ...)
//
// Does NOT lock treasury_accounts (inflow cannot overdraw). No deadlock risk vs
// the payment path (treasury_accounts → supplier_payables) because we never
// acquire the treasury_accounts lock here.
//
// Does NOT call applyReturnCredit (FIFO walk). The lot-specific flow targets only
// the lot's own payable via stock_movement_id.
//
// Does NOT write supplier_payments → paidThisMonth KPI unaffected.
// Does NOT write expenses → P&L unaffected.

export type ReturnLotInput = {
  organizationId: string;
  lotId: string;
  qtyReturned: number;
  refundContainerId?: string | null;
  createdBy: string;
  note?: string | null;
};

export type ReturnLotResult = {
  returnValue: number;
  creditPortion: number;
  refundPortion: number;
  exitMovementId: string;
  treasuryMovementId: string | null;
  refundId: string | null;
};

export async function returnLot(
  executor: Executor,
  input: ReturnLotInput,
): Promise<ReturnLotResult> {
  const { organizationId, lotId, qtyReturned, refundContainerId, createdBy, note } = input;

  // ── Step 1: Lock the lot row (serializes concurrent returns on same lot) ──

  const [lot] = await executor
    .select({
      id: stockMovementsSchema.id,
      productId: stockMovementsSchema.productId,
      remainingQty: stockMovementsSchema.remainingQty,
      unitCost: stockMovementsSchema.unitCost,
      supplierId: stockMovementsSchema.supplierId,
    })
    .from(stockMovementsSchema)
    .where(
      and(
        eq(stockMovementsSchema.id, lotId),
        eq(stockMovementsSchema.organizationId, organizationId),
        eq(stockMovementsSchema.type, 'entry'),
      ),
    )
    .for('update');

  if (!lot) {
    throw new Error('qty_exceeds_remaining'); // lot not found — treat as guard failure
  }

  const remaining = Number(lot.remainingQty ?? 0);
  if (qtyReturned > remaining + 0.0005) {
    throw new Error('qty_exceeds_remaining');
  }

  // ── Step 2: Lock the payable (fresh outstanding, serializes with payments) ─

  const [payable] = await executor
    .select({
      id: supplierPayablesSchema.id,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
      supplierId: supplierPayablesSchema.supplierId,
    })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.stockMovementId, lotId),
        eq(supplierPayablesSchema.organizationId, organizationId),
      ),
    )
    .for('update');

  // ── Step 3: Compute split math with fresh values ──────────────────────────

  const unitCost = lot.unitCost != null ? Number(lot.unitCost) : 0;
  const returnValue = round2(qtyReturned * unitCost);

  let outstanding = 0;
  if (payable) {
    const total = Number(payable.totalAmount);
    const paid = Number(payable.paidAmount);
    const credited = Number(payable.creditedAmount ?? '0');
    outstanding = Math.max(0, round2(total - paid - credited));
  }

  const creditPortion = round2(Math.min(returnValue, outstanding));
  const refundPortion = round2(returnValue - creditPortion);

  // ── Step 4: Validate container requirement ────────────────────────────────

  if (refundPortion > 0.005 && !refundContainerId) {
    throw new Error('refund_container_required');
  }

  // ── Step 5: Consume qty from lot ─────────────────────────────────────────

  await executor
    .update(stockMovementsSchema)
    .set({
      remainingQty: sql`${stockMovementsSchema.remainingQty} - ${qtyReturned}`,
    })
    .where(eq(stockMovementsSchema.id, lotId));

  // ── Step 6: INSERT exit stock_movements row ───────────────────────────────

  const [exitRow] = await executor
    .insert(stockMovementsSchema)
    .values({
      organizationId,
      productId: lot.productId,
      type: 'exit',
      qty: qtyReturned,
      remainingQty: null,
      unitCost: lot.unitCost,
      reason: 'return_supplier',
      supplierId: lot.supplierId,
      createdBy,
      notes: note ?? null,
    })
    .returning({ id: stockMovementsSchema.id });

  if (!exitRow) {
    throw new Error('stock_movements exit: insert returned no row');
  }

  // ── Step 7: UPDATE products.stock ────────────────────────────────────────

  await executor
    .update(productsSchema)
    .set({
      stock: sql`GREATEST(0, ${productsSchema.stock} - ${qtyReturned})`,
    })
    .where(
      and(
        eq(productsSchema.id, lot.productId),
        eq(productsSchema.organizationId, organizationId),
      ),
    );

  // ── Step 8: Refund inflow (if refundPortion > 0) ─────────────────────────

  let treasuryMovementId: string | null = null;
  let refundId: string | null = null;

  if (refundPortion > 0.005 && refundContainerId) {
    // INSERT treasury_movements (type='refund', from=null, to=container).
    // Credit-only inflow: no balance guard needed (can't overdraw a destination).
    const [tmRow] = await executor
      .insert(treasuryMovementsSchema)
      .values({
        organizationId,
        fromAccountId: null,
        toAccountId: refundContainerId,
        amount: refundPortion.toFixed(2),
        type: 'refund',
        reason: note ?? null,
        createdBy,
      })
      .returning({ id: treasuryMovementsSchema.id });

    if (!tmRow) {
      throw new Error('treasury_movements refund: insert returned no row');
    }
    treasuryMovementId = tmRow.id as string;

    // INSERT supplier_refunds.
    const [refundRow] = await executor
      .insert(supplierRefundsSchema)
      .values({
        organizationId,
        supplierId: payable?.supplierId ?? lot.supplierId ?? '',
        payableId: payable?.id ?? null,
        stockMovementId: exitRow.id as string,
        treasuryMovementId,
        amount: refundPortion.toFixed(2),
        note: note ?? null,
        createdBy,
      })
      .returning({ id: supplierRefundsSchema.id });

    if (!refundRow) {
      throw new Error('supplier_refunds: insert returned no row');
    }
    refundId = refundRow.id as string;
  }

  // ── Step 9: Credit write (if creditPortion > 0 and payable exists) ────────

  if (creditPortion > 0.005 && payable) {
    await writeLotReturnCredit(executor, {
      organizationId,
      supplierId: payable.supplierId,
      payableId: payable.id,
      exitMovementId: exitRow.id as string,
      creditPortion,
      createdBy,
      note,
    });
  }

  return {
    returnValue,
    creditPortion,
    refundPortion,
    exitMovementId: exitRow.id as string,
    treasuryMovementId,
    refundId,
  };
}
