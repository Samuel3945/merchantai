import type { db } from '@/libs/DB';
import type { stockMovementsSchema } from '@/models/Schema';
import { sql } from 'drizzle-orm';

// The exact transaction type drizzle hands to a db.transaction callback.
type RawTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The ONE batch-consumption order every FIFO consumer (sales, manual mermas,
// damaged-exchange mermas) must share so they never diverge.
//
// Change-of-mind restocks (reason 'return_sale') jump to the FRONT of the queue
// and are sold before regular stock — and among themselves the most recent
// return goes first ("como pila"/LIFO). A returned unit belongs to an older
// batch (closer to its expiry), so it must be the next one out the door instead
// of sitting behind fresh stock until it expires. Regular stock keeps strict
// FIFO by entry date. created_at is never mutated, so the audit/history trail
// stays truthful; priority lives here in the ordering, not in the timestamp.
//
// CASE (not `(reason = 'return_sale') DESC`) so a NULL reason sorts as a normal
// batch instead of NULLS-FIRST jumping the queue.
export const fifoBatchOrder = sql`
  CASE WHEN reason = 'return_sale' THEN 0 ELSE 1 END ASC,
  CASE WHEN reason = 'return_sale' THEN created_at END DESC,
  created_at ASC
`;

export type FifoSaleLine = {
  productId: string;
  productName: string;
  qty: number;
  // products.cost — used to value any units a sale consumes that the FIFO
  // ledger doesn't cover (legacy stock created without entry batches).
  fallbackCost: string;
};

// Consumes the oldest open entry batches (FIFO) for each sold line, decrements
// their remaining_qty, and returns the exit-movement rows with the weighted
// unit cost captured. EVERY sale path (createSale server action + POS API
// routes) must build its exits through this so COGS/margin can never diverge
// between them again. Caller is responsible for inserting the returned rows.
export async function consumeFifoExits(
  tx: RawTx,
  orgId: string,
  createdBy: string | null,
  saleId: string,
  lines: FifoSaleLine[],
): Promise<(typeof stockMovementsSchema.$inferInsert)[]> {
  const exitRows: (typeof stockMovementsSchema.$inferInsert)[] = [];

  for (const line of lines) {
    const fallback = Number(line.fallbackCost) || 0;
    let remaining = line.qty;
    let totalCost = 0;

    const batches = await tx.execute(sql`
      SELECT id, remaining_qty, unit_cost
      FROM stock_movements
      WHERE organization_id = ${orgId}
        AND product_id = ${line.productId}
        AND type = 'entry'
        AND remaining_qty IS NOT NULL
        AND remaining_qty > 0
      ORDER BY ${fifoBatchOrder}
      FOR UPDATE
    `);

    const rows = (batches.rows ?? []) as {
      id: string;
      remaining_qty: number;
      unit_cost: string | null;
    }[];
    for (const b of rows) {
      if (remaining <= 0) {
        break;
      }
      const take = Math.min(Number(b.remaining_qty), remaining);
      totalCost += take * (b.unit_cost != null ? Number(b.unit_cost) : fallback);
      remaining -= take;
      await tx.execute(sql`
        UPDATE stock_movements
        SET remaining_qty = remaining_qty - ${take}
        WHERE id = ${b.id}
      `);
    }

    if (remaining > 0) {
      totalCost += remaining * fallback;
    }

    const unitCost = line.qty > 0 ? totalCost / line.qty : 0;
    exitRows.push({
      organizationId: orgId,
      productId: line.productId,
      productName: line.productName,
      type: 'exit',
      qty: line.qty,
      unitCost: unitCost.toFixed(2),
      reason: 'sale',
      saleId,
      createdBy,
    });
  }

  return exitRows;
}
