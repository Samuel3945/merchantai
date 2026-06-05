import type { db } from '@/libs/DB';
import { and, eq, sql } from 'drizzle-orm';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { formatSaleNumber } from '@/libs/sale-number';
import {
  cashMovementsSchema,
  posReturnItemsSchema,
  posReturnsSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

// Shared core for processing a sale return. Both the POS route
// (cashier-authenticated) and the dashboard server action (Clerk admin) run
// this inside their own transaction, so the money/stock/cash logic lives in ONE
// place instead of drifting across two backends.

export const VALID_RETURN_REASONS = [
  'wrong_product',
  'damaged',
  'customer_request',
  'price_error',
  'duplicate',
  'other',
  'business_error',
  'warranty',
] as const;

export type ReturnReason = (typeof VALID_RETURN_REASONS)[number];

// Where the returned goods physically go. Only 'restock' returns units to
// sellable stock; the rest are recorded for audit and do not touch inventory.
export const VALID_RETURN_DISPOSITIONS = [
  'restock',
  'damaged',
  'warranty',
  'discard',
] as const;

export type ReturnDisposition = (typeof VALID_RETURN_DISPOSITIONS)[number];

export type ReturnItemInput = {
  saleItemId?: string;
  qty?: number;
  refundAmount?: number | string;
  /** @deprecated Prefer `disposition`; kept for older POS clients. */
  restock?: boolean;
  disposition?: ReturnDisposition;
};

export type ApplySaleReturnParams = {
  saleId: string;
  organizationId: string;
  /** pos_users.id (uuid) for POS cashiers, or null for dashboard admins. */
  cashierId: string | null;
  /** Human label stored in stock/cash movement audit columns. */
  actorName: string;
  reason: ReturnReason;
  refundMethod: string;
  items: ReturnItemInput[];
  notes?: string | null;
  partial: boolean;
};

export type ApplySaleReturnResult = {
  id: string;
  totalRefunded: string;
  items: (typeof posReturnItemsSchema.$inferSelect)[];
  partial: boolean;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CASH_METHODS = new Set(['efectivo', 'cash']);

/**
 * Applies a (full or partial) return for a sale within the given transaction.
 *
 * Locks the sale row FOR UPDATE, validates each line against what is still
 * returnable, writes the pos_returns + pos_return_items records, restocks
 * inventory (with a stock_movements entry), flips the sale to `returned` when
 * the whole sale comes back, and books the cash outflow when the refund is in
 * cash. Throws on any validation failure so the caller can map it to a 4xx.
 */
export async function applySaleReturn(
  tx: Tx,
  params: ApplySaleReturnParams,
): Promise<ApplySaleReturnResult> {
  const {
    organizationId,
    cashierId,
    actorName,
    reason,
    refundMethod: rawRefundMethod,
    items,
    notes,
    partial,
  } = params;

  const refundMethod = rawRefundMethod?.trim();

  if (!reason || !VALID_RETURN_REASONS.includes(reason)) {
    throw new Error('reason inválido');
  }
  if (!refundMethod) {
    throw new Error('refundMethod es requerido');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items es requerido');
  }

  const [sale] = await tx
    .select({
      id: salesSchema.id,
      status: salesSchema.status,
      saleNumber: salesSchema.saleNumber,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, params.saleId),
        eq(salesSchema.organizationId, organizationId),
      ),
    )
    .for('update')
    .limit(1);

  if (!sale) {
    throw new Error('Venta no encontrada');
  }
  if (sale.status === 'cancelled') {
    throw new Error('La venta ya fue cancelada');
  }
  if (sale.status === 'returned') {
    throw new Error('La venta ya fue devuelta completamente');
  }

  const saleItemRows = await tx
    .select()
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, sale.id));

  const saleItemById = new Map(saleItemRows.map(r => [r.id, r]));

  type Resolved = {
    saleItemId: string;
    productId: string;
    productName: string;
    qty: number;
    refundAmount: string;
    restock: boolean;
    disposition: ReturnDisposition;
  };

  const resolved: Resolved[] = [];
  let totalRefund = 0;

  for (const it of items) {
    if (!it.saleItemId) {
      throw new Error('saleItemId requerido en cada item');
    }
    const orig = saleItemById.get(it.saleItemId);
    if (!orig) {
      throw new Error(`Item de venta no encontrado: ${it.saleItemId}`);
    }

    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error('qty debe ser > 0');
    }

    const amountNum = Number(it.refundAmount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      throw new Error('refundAmount debe ser ≥ 0');
    }

    const [{ alreadyReturned } = { alreadyReturned: 0 }] = await tx
      .select({
        alreadyReturned: sql<number>`COALESCE(SUM(${posReturnItemsSchema.qty}), 0)::int`,
      })
      .from(posReturnItemsSchema)
      .where(eq(posReturnItemsSchema.saleItemId, orig.id));

    const maxReturnable = Number(orig.qty) - Number(alreadyReturned);
    if (qty > maxReturnable) {
      throw new Error(
        `Solo quedan ${maxReturnable} unidades devolvibles para "${orig.productName}"`,
      );
    }

    // Disposition is the source of truth. Older POS clients that only sent
    // `restock: false` are mapped to 'discard' (goods did not return to stock).
    const disposition: ReturnDisposition
      = it.disposition ?? (it.restock === false ? 'discard' : 'restock');
    const restock = disposition === 'restock';

    totalRefund += amountNum;
    resolved.push({
      saleItemId: orig.id,
      productId: orig.productId,
      productName: orig.productName,
      qty,
      refundAmount: toMoney(amountNum),
      restock,
      disposition,
    });
  }

  const totalRefundStr = toMoney(totalRefund);

  const [returnRow] = await tx
    .insert(posReturnsSchema)
    .values({
      organizationId,
      saleId: sale.id,
      reason,
      notes: notes ?? null,
      totalRefunded: totalRefundStr,
      refundMethod,
      partial,
      cashierId,
    })
    .returning();

  if (!returnRow) {
    throw new Error('No se pudo crear la devolución');
  }

  const insertedItems = await tx
    .insert(posReturnItemsSchema)
    .values(
      resolved.map(r => ({
        returnId: returnRow.id,
        saleItemId: r.saleItemId,
        productId: r.productId,
        productName: r.productName,
        qty: r.qty,
        refundAmount: r.refundAmount,
        restock: r.restock,
        disposition: r.disposition,
      })),
    )
    .returning();

  for (const r of resolved) {
    if (r.restock) {
      // Customer changed their mind: the goods go back to sellable stock.
      await tx
        .update(productsSchema)
        .set({ stock: sql`${productsSchema.stock} + ${r.qty}` })
        .where(
          and(
            eq(productsSchema.id, r.productId),
            eq(productsSchema.organizationId, organizationId),
          ),
        );
      // Drizzle insert (not raw SQL) so organization_id — a NOT NULL column — is
      // always written; the previous raw INSERT omitted it and broke restocks.
      await tx.insert(stockMovementsSchema).values({
        organizationId,
        productId: r.productId,
        productName: r.productName,
        type: 'entry',
        qty: r.qty,
        reason: 'return_sale',
        saleId: sale.id,
        createdBy: actorName,
      });
    } else if (r.disposition === 'damaged') {
      // Damaged return: the goods do NOT re-enter sellable stock. We log the
      // loss in the ledger (type 'adjustment', no remaining_qty so FIFO ignores
      // it and product.stock is untouched) so inventory history shows the unit
      // left because it was damaged.
      await tx.insert(stockMovementsSchema).values({
        organizationId,
        productId: r.productId,
        productName: r.productName,
        type: 'adjustment',
        qty: r.qty,
        reason: 'return_damaged',
        saleId: sale.id,
        createdBy: actorName,
      });
    }
    // warranty | discard: recorded on pos_return_items.disposition only.
  }

  if (!partial) {
    await tx
      .update(salesSchema)
      .set({ status: 'returned' })
      .where(eq(salesSchema.id, sale.id));
  }

  if (CASH_METHODS.has(refundMethod.toLowerCase()) && totalRefund > 0) {
    const open = await findOpenSession(tx, organizationId);
    if (open) {
      await tx.insert(cashMovementsSchema).values({
        sessionId: open.id,
        organizationId,
        type: 'adjustment',
        amount: toMoney(-totalRefund),
        reason: `Devolución venta ${formatSaleNumber(sale.saleNumber)}${partial ? ' (parcial)' : ''}`,
        createdBy: actorName,
        authorizedBy: actorName,
        saleId: sale.id,
      });
    }
  }

  return {
    id: returnRow.id,
    totalRefunded: totalRefundStr,
    items: insertedItems,
    partial,
  };
}
