import type { db } from '@/libs/DB';
import { sql } from 'drizzle-orm';
import { orgSaleCountersSchema } from '@/models/Schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomically allocate the next per-organization sale number inside the sale
 * transaction. The UPSERT creates the org counter on first sale (→ 1) or locks
 * and increments the existing row, returning the new value. Because the counter
 * row is locked for the duration of the transaction, two concurrent sales — one
 * from the POS, one from the dashboard — can never receive the same number.
 */
export async function assignNextSaleNumber(
  tx: Tx,
  organizationId: string,
): Promise<number> {
  const [row] = await tx
    .insert(orgSaleCountersSchema)
    .values({ organizationId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: orgSaleCountersSchema.organizationId,
      set: { lastNumber: sql`${orgSaleCountersSchema.lastNumber} + 1` },
    })
    .returning({ lastNumber: orgSaleCountersSchema.lastNumber });

  if (!row) {
    throw new Error('No se pudo asignar el número de venta');
  }
  return row.lastNumber;
}

export type SaleNumberFormat = {
  /** Leading token, e.g. "#" (default), "V-", "FAC-". */
  prefix?: string;
  /** Zero-pad the number to this width, e.g. 6 → "000001". 0 = no padding. */
  padding?: number;
};

/**
 * Render a sale number as the commercial identifier shown to users. Default is
 * "#1001"; the optional format is the seam for per-organization configuration
 * later (e.g. "V-000001", "FAC-1001") without changing the stored integer.
 */
export function formatSaleNumber(
  saleNumber: number | null | undefined,
  format: SaleNumberFormat = {},
): string {
  if (saleNumber == null) {
    return '—';
  }
  const { prefix = '#', padding = 0 } = format;
  const body
    = padding > 0
      ? String(saleNumber).padStart(padding, '0')
      : String(saleNumber);
  return `${prefix}${body}`;
}
