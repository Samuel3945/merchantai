import type { db } from '@/libs/DB';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { fifoBatchOrder } from '@/libs/fifo-cogs';
import { assertReturnAllowed, loadReturnPolicy } from '@/libs/return-policy';
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
] as const;

export type ReturnReason = (typeof VALID_RETURN_REASONS)[number];

// Where the returned goods physically go. Only 'restock' returns units to
// sellable stock; the rest are recorded for audit and do not touch inventory.
export const VALID_RETURN_DISPOSITIONS = [
  'restock',
  'damaged',
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
  /**
   * True when an org admin is processing from the web panel. Drives the
   * "requiere autorización de administrador" rule; POS cashiers pass false.
   */
  authorizedByAdmin?: boolean;
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
 * FIFO-values and records a damaged unit leaving sellable stock as a merma.
 *
 * Mirrors recordMovement()'s exit path: draw down the oldest open entry batches
 * to capture the weighted unit cost, decrement their remaining_qty, write ONE
 * 'exit' movement (reason 'damaged') so it surfaces in the Mermas report at
 * cost, and lower product.stock. saleId is intentionally left null: this is a
 * merma, not part of the sale's COGS, so the cost queries that filter by
 * sale_id never double-count it.
 */
async function recordDamagedExit(
  tx: Tx,
  organizationId: string,
  actorName: string,
  line: { productId: string; productName: string; qty: number },
): Promise<void> {
  const [product] = await tx
    .select({ cost: productsSchema.cost })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.id, line.productId),
        eq(productsSchema.organizationId, organizationId),
      ),
    )
    .limit(1);

  const fallback = Number(product?.cost) || 0;

  const batches = await tx
    .select({
      id: stockMovementsSchema.id,
      remainingQty: stockMovementsSchema.remainingQty,
      unitCost: stockMovementsSchema.unitCost,
    })
    .from(stockMovementsSchema)
    .where(
      and(
        eq(stockMovementsSchema.organizationId, organizationId),
        eq(stockMovementsSchema.productId, line.productId),
        eq(stockMovementsSchema.type, 'entry'),
        gt(stockMovementsSchema.remainingQty, 0),
      ),
    )
    .orderBy(fifoBatchOrder)
    .for('update');

  let remaining = line.qty;
  let totalCost = 0;
  for (const b of batches) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(b.remainingQty ?? 0, remaining);
    totalCost += take * (b.unitCost != null ? Number(b.unitCost) : fallback);
    remaining -= take;
    await tx
      .update(stockMovementsSchema)
      .set({ remainingQty: sql`${stockMovementsSchema.remainingQty} - ${take}` })
      .where(eq(stockMovementsSchema.id, b.id));
  }
  // Units the FIFO ledger doesn't cover fall back to the product's reference cost.
  if (remaining > 0) {
    totalCost += remaining * fallback;
  }
  const unitCost = line.qty > 0 ? (totalCost / line.qty).toFixed(2) : '0';

  await tx.insert(stockMovementsSchema).values({
    organizationId,
    productId: line.productId,
    productName: line.productName,
    type: 'exit',
    qty: line.qty,
    reason: 'damaged',
    unitCost,
    saleId: null,
    createdBy: actorName,
  });

  await tx
    .update(productsSchema)
    .set({ stock: sql`GREATEST(0, ${productsSchema.stock} - ${line.qty})` })
    .where(
      and(
        eq(productsSchema.id, line.productId),
        eq(productsSchema.organizationId, organizationId),
      ),
    );
}

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
      createdAt: salesSchema.createdAt,
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

  // Business rules from Ajustes → Devoluciones: enabled, max days since the
  // sale, and admin-only authorization. Enforced here so the POS route and the
  // dashboard action can never drift apart.
  const policy = await loadReturnPolicy(tx, organizationId);
  assertReturnAllowed(policy, sale.createdAt, {
    isAdmin: params.authorizedByAdmin === true,
  });
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

    // `reason` is the return-level intent: a damaged return means every line is
    // a damaged exchange, no matter what the client sent per item — so neither
    // the POS nor a stale client can accidentally restock or refund it. For any
    // other reason the per-item disposition wins; older POS clients that only
    // sent `restock: false` are mapped to 'discard' (goods did not return).
    const disposition: ReturnDisposition
      = reason === 'damaged'
        ? 'damaged'
        : (it.disposition ?? (it.restock === false ? 'discard' : 'restock'));
    const restock = disposition === 'restock';

    // A damaged unit is an exchange, not a money-back return: the customer gets
    // a replacement, so no cash leaves the register. The only economic loss is
    // the unit cost, booked as a 'damaged' exit (merma) below. Force the refund
    // to 0 server-side so neither the POS nor the dashboard can refund a damaged
    // line by mistake.
    const refund = disposition === 'damaged' ? 0 : amountNum;

    totalRefund += refund;
    resolved.push({
      saleItemId: orig.id,
      productId: orig.productId,
      productName: orig.productName,
      qty,
      refundAmount: toMoney(refund),
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

      // Re-attribute the cost this line was actually sold at, captured on the
      // sale's FIFO exit, so the returned units carry truthful COGS when resold.
      // NULL (legacy sales with no ledger exit) is fine: FIFO falls back to the
      // product's reference cost on consumption.
      const [soldExit] = await tx
        .select({ unitCost: stockMovementsSchema.unitCost })
        .from(stockMovementsSchema)
        .where(
          and(
            eq(stockMovementsSchema.saleId, sale.id),
            eq(stockMovementsSchema.productId, r.productId),
            eq(stockMovementsSchema.type, 'exit'),
            eq(stockMovementsSchema.reason, 'sale'),
          ),
        )
        .limit(1);

      // A returned unit belongs to an older batch, so inherit the soonest-
      // expiring open batch's date. This keeps a perishable return on the
      // expiration engine's radar (it only tracks entries that carry expiresAt)
      // and reflects that this stock is closer to its expiry than fresh stock.
      const [frontBatch] = await tx
        .select({ expiresAt: stockMovementsSchema.expiresAt })
        .from(stockMovementsSchema)
        .where(
          and(
            eq(stockMovementsSchema.organizationId, organizationId),
            eq(stockMovementsSchema.productId, r.productId),
            eq(stockMovementsSchema.type, 'entry'),
            gt(stockMovementsSchema.remainingQty, 0),
            isNotNull(stockMovementsSchema.expiresAt),
          ),
        )
        .orderBy(stockMovementsSchema.expiresAt)
        .limit(1);

      // Drizzle insert (not raw SQL) so organization_id — a NOT NULL column — is
      // always written; the previous raw INSERT omitted it and broke restocks.
      // remainingQty is REQUIRED: without it the units increment product.stock
      // but never re-enter the FIFO ledger (consumers filter remaining_qty > 0),
      // so the next sale would draw the wrong batch and COGS would drift. The
      // 'return_sale' reason sends this batch to the FRONT of the queue (see
      // fifoBatchOrder) so it sells before fresh stock.
      await tx.insert(stockMovementsSchema).values({
        organizationId,
        productId: r.productId,
        productName: r.productName,
        type: 'entry',
        qty: r.qty,
        remainingQty: r.qty,
        unitCost: soldExit?.unitCost ?? null,
        expiresAt: frontBatch?.expiresAt ?? null,
        reason: 'return_sale',
        saleId: sale.id,
        createdBy: actorName,
      });
    } else if (r.disposition === 'damaged') {
      // Damaged exchange: the customer keeps a replacement and the damaged unit
      // is binned, so ONE unit leaves sellable stock. Record a single 'exit'
      // (reason 'damaged') valued via FIFO — exactly like a manual merma in
      // recordMovement() — so the history shows one salida, the stock drops, and
      // the loss surfaces in the Mermas report at cost.
      await recordDamagedExit(tx, organizationId, actorName, r);
    }
    // discard: recorded on pos_return_items.disposition only.
  }

  // A change-of-mind return voids the sale (goods back, money back → net zero),
  // so a full one flips it to 'returned'. A damaged exchange does NOT: the
  // customer walks out with a working replacement and the sale's revenue stands,
  // so the sale stays 'completed' and only the merma is recorded.
  if (!partial && reason !== 'damaged') {
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
