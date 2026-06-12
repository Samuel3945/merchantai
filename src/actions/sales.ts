'use server';

import type {
  ReturnPolicy,
} from '@/libs/return-policy';
import type {
  ReturnDisposition,
  ReturnReason,
} from '@/libs/sale-returns';
import { auth, clerkClient, currentUser } from '@clerk/nextjs/server';
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { recordCashMovement } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  maybeAutoEmitInvoice,
  maybeEmitCreditNote,
} from '@/libs/einvoice/emit';
import { createFiado } from '@/libs/fiados';
import { fiadoAmountFor } from '@/libs/fiados-math';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { loadReturnPolicy } from '@/libs/return-policy';
import { assignNextSaleNumber } from '@/libs/sale-number';
import { applySaleReturn } from '@/libs/sale-returns';
import { wholesaleUnitPrice } from '@/libs/wholesale';
import {
  posReturnItemsSchema,
  posReturnsSchema,
  posTokensSchema,
  posUsersSchema,
  productsSchema,
  saleItemsSchema,
  salePaymentsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

export type SalePaymentInput = {
  method: string;
  amount: number | string;
  reference?: string | null;
  billsPaid?: unknown;
  changeGiven?: number | string;
};

export type CreateSaleInput = {
  items: { productId: string; qty: number }[];
  paymentType: string;
  notes?: string | null;
  payments?: SalePaymentInput[];
  // For fiado sales: optional manual due date ('YYYY-MM-DD'). When omitted, the
  // org default term applies (fiados.default_term_days, 30 by default).
  dueDate?: string | null;
};

function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

export async function createSale(input: CreateSaleInput) {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  if (!input.items || input.items.length === 0) {
    throw new Error('Sale must include at least one item');
  }

  for (const item of input.items) {
    if (!item.productId) {
      throw new Error('Each item must include a productId');
    }
    if (!Number.isFinite(item.qty) || item.qty <= 0) {
      throw new Error('Each item must have qty > 0');
    }
  }

  const result = await db.transaction(async (tx) => {
    let total = 0;
    const itemsToInsert: {
      productId: string;
      productName: string;
      qty: number;
      price: string;
      subtotal: string;
      unitType: string;
    }[] = [];
    // Reference cost per line (products.cost), used as a fallback when the FIFO
    // ledger doesn't fully cover the sold quantity (e.g. legacy stock with no
    // entry batches). Aligned by index with itemsToInsert.
    const lineFallbackCost: string[] = [];

    for (const item of input.items) {
      const [product] = await tx
        .select()
        .from(productsSchema)
        .where(
          and(
            eq(productsSchema.id, item.productId),
            eq(productsSchema.organizationId, orgId),
            eq(productsSchema.deleted, false),
          ),
        )
        .for('update')
        .limit(1);

      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      // Only published products are sellable. Archived/draft must not enter a
      // live sale — that's the whole point of archiving.
      if (product.status !== 'published') {
        throw new Error(
          `"${product.name}" no está disponible para la venta.`,
        );
      }

      if (product.stock < item.qty) {
        throw new Error(
          `Insufficient stock for "${product.name}" (available: ${product.stock}, requested: ${item.qty})`,
        );
      }

      const basePrice = Number.parseFloat(product.price);
      if (!Number.isFinite(basePrice)) {
        throw new TypeError(`Invalid price for product ${product.id}`);
      }
      // Wholesale: qty-based tier pricing, same rule as the POS sale route.
      const unitPrice = wholesaleUnitPrice(
        basePrice,
        product.isWholesale,
        product.wholesaleTiers,
        item.qty,
      );
      const subtotal = unitPrice * item.qty;
      total += subtotal;

      itemsToInsert.push({
        productId: product.id,
        productName: product.name,
        qty: item.qty,
        price: toMoney(unitPrice),
        subtotal: toMoney(subtotal),
        unitType: product.unitType,
      });
      lineFallbackCost.push(product.cost);
    }

    const totalStr = toMoney(total);

    const saleNumber = await assignNextSaleNumber(tx, orgId);

    const [sale] = await tx
      .insert(salesSchema)
      .values({
        organizationId: orgId,
        saleNumber,
        total: totalStr,
        paymentType: input.paymentType,
        status: 'completed',
        notes: input.notes ?? null,
        cashierId: userId,
      })
      .returning();

    if (!sale) {
      throw new Error('Failed to create sale');
    }

    const insertedItems = await tx
      .insert(saleItemsSchema)
      .values(itemsToInsert.map(it => ({ saleId: sale.id, ...it })))
      .returning();

    // FIFO consumption + exit cost capture, shared by every sale path.
    const exitRows = await consumeFifoExits(
      tx,
      orgId,
      userId,
      sale.id,
      itemsToInsert.map((it, i) => ({
        productId: it.productId,
        productName: it.productName,
        qty: it.qty,
        fallbackCost: lineFallbackCost[i] ?? '0',
      })),
    );

    // Stock on hand stays the authoritative quantity; the FIFO ledger above
    // mirrors it batch by batch.
    for (const item of input.items) {
      await tx
        .update(productsSchema)
        .set({
          stock: sql`GREATEST(0, ${productsSchema.stock} - ${item.qty})`,
        })
        .where(
          and(
            eq(productsSchema.id, item.productId),
            eq(productsSchema.organizationId, orgId),
          ),
        );
    }

    await tx.insert(stockMovementsSchema).values(exitRows);

    const paymentRows
      = input.payments && input.payments.length > 0
        ? input.payments.map(p => ({
            saleId: sale.id,
            method: p.method,
            amount: toMoney(p.amount),
            reference: p.reference ?? null,
            billsPaid: p.billsPaid ?? null,
            changeGiven:
              p.changeGiven !== undefined ? toMoney(p.changeGiven) : '0',
          }))
        : [
            {
              saleId: sale.id,
              method: input.paymentType,
              amount: totalStr,
              reference: null,
              billsPaid: null,
              changeGiven: '0',
            },
          ];

    const insertedPayments = await tx
      .insert(salePaymentsSchema)
      .values(paymentRows)
      .returning();

    // Fiado: book the credit account for the portion NOT covered by an upfront
    // non-fiado payment. A 100%-fiado sale owes the full total; a split sale
    // (e.g. part efectivo now, rest fiado) owes only the remainder. The efectivo
    // part still hits the drawer via recordCashMovement below.
    const fiadoAmount = fiadoAmountFor(total, paymentRows);
    const isFiado
      = /fiado/i.test(input.paymentType)
        || paymentRows.some(p => /fiado/i.test(p.method));
    if (isFiado && fiadoAmount > 0) {
      await createFiado(tx, {
        organizationId: orgId,
        saleId: sale.id,
        originalAmount: fiadoAmount,
        dueDate: input.dueDate ?? null,
        createdBy: userId,
        notes: input.notes ?? null,
      });
    }

    return { ...sale, items: insertedItems, payments: insertedPayments };
  });

  await recordCashMovement(result.id, result.total);

  // Best-effort: emit the electronic invoice now if a provider is configured.
  // Never awaited into the response — the sale already succeeded; a failed
  // emission stays retriable from the Facturas module.
  void maybeAutoEmitInvoice(orgId, result.id);

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'sale.created',
    entityType: 'sale',
    entityId: result.id,
    after: {
      id: result.id,
      total: result.total,
      paymentType: result.paymentType,
      status: result.status,
      itemCount: result.items.length,
    },
    metadata: {
      paymentType: input.paymentType,
      payments: result.payments.map(p => ({
        method: p.method,
        amount: p.amount,
      })),
    },
  });

  revalidatePath('/dashboard/sales');
  revalidatePath('/dashboard/products');

  return result;
}

export type Sale = typeof salesSchema.$inferSelect;

// A sale row enriched for the listing: whether it already has any return on
// record (drives the status badge / action label) and the cashier resolved to a
// human name + optional avatar, so the table never shows a raw user id.
export type SaleListRow = Sale & {
  hasReturn: boolean;
  // True when every sold unit has been returned, computed by QUANTITY (returned
  // units >= sold units) — not by status. A damaged full return keeps the sale
  // 'completed', and a sale fully returned across several partials never flips
  // to 'returned' either, so status alone would wrongly leave it reopenable.
  fullyReturned: boolean;
  cashierName: string | null;
  cashierImageUrl: string | null;
  deviceName: string | null;
};

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves sale cashier ids to display names in one batch per listing page.
// POS cashiers are pos_users (uuid) with a stored name; dashboard sales carry a
// Clerk user id ("user_..."), resolved best-effort via a single Clerk call.
// No per-row lookups, no denormalized column, and it works for historical rows.
async function resolveCashiers(
  ids: string[],
): Promise<Map<string, { name: string; imageUrl: string | null }>> {
  const map = new Map<string, { name: string; imageUrl: string | null }>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) {
    return map;
  }

  const uuidIds = unique.filter(id => UUID_RE.test(id));
  const clerkIds = unique.filter(id => id.startsWith('user_'));

  if (uuidIds.length > 0) {
    const rows = await db
      .select({ id: posUsersSchema.id, name: posUsersSchema.name })
      .from(posUsersSchema)
      .where(inArray(posUsersSchema.id, uuidIds));
    for (const r of rows) {
      map.set(r.id, { name: r.name, imageUrl: null });
    }
  }

  if (clerkIds.length > 0) {
    try {
      const client = await clerkClient();
      const { data } = await client.users.getUserList({
        userId: clerkIds,
        limit: clerkIds.length,
      });
      for (const u of data) {
        const name
          = u.fullName
            || [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
            || u.username
            || u.primaryEmailAddress?.emailAddress
            || 'Administrador';
        map.set(u.id, { name, imageUrl: u.imageUrl || null });
      }
    } catch {
      // Clerk unavailable → the UI falls back to initials for these rows.
    }
  }

  return map;
}

// Resolves posTokenId UUIDs to device names in one batch query.
async function resolveDeviceNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) {
    return map;
  }
  const rows = await db
    .select({ id: posTokensSchema.id, deviceName: posTokensSchema.deviceName })
    .from(posTokensSchema)
    .where(inArray(posTokensSchema.id, unique));
  for (const r of rows) {
    map.set(r.id, r.deviceName);
  }
  return map;
}

export type ListSalesFilters = {
  limit?: number;
  offset?: number;
  start?: string | null;
  end?: string | null;
  payment?: string | null;
  search?: string | null;
  cashierId?: string | null;
  /** Filter by the POS register (pos_tokens.id) the sale was made on. */
  posTokenId?: string | null;
  /** Filter sales containing a specific product. */
  productId?: string | null;
  /** Where the sale was made: a POS device or the web panel. */
  origin?: 'all' | 'pos' | 'panel' | null;
  /** Return state, by quantity (same rule as the listing badges). */
  returnState?: 'all' | 'clean' | 'partial' | 'returned' | null;
};

// Quantity-based return predicates shared by the WHERE filters and the listing
// columns. Literal table refs on purpose — see the note inside listSales.
const HAS_RETURN_SQL = `EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)`;
const FULLY_RETURNED_SQL = `(
  ${HAS_RETURN_SQL}
  AND COALESCE((
    SELECT SUM(pri.qty)
    FROM pos_return_items pri
    JOIN sale_items si ON si.id = pri.sale_item_id
    WHERE si.sale_id = sales.id
  ), 0) >= COALESCE((
    SELECT SUM(si2.qty) FROM sale_items si2 WHERE si2.sale_id = sales.id
  ), 0)
)`;

// Lightweight, org-scoped option lists for the sales filter bar: every POS
// register, every active employee, and the product catalog. One round trip.
export type SalesFilterOptions = {
  registers: { id: string; name: string }[];
  employees: { id: string; name: string }[];
  products: { id: string; name: string }[];
  /** Return rules so the listing can disable "Devolver" up front. */
  returnPolicy: ReturnPolicy;
};

export async function getSalesFilterOptions(): Promise<SalesFilterOptions> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const returnPolicy = await loadReturnPolicy(db, orgId);

  const [registers, employees, products] = await Promise.all([
    db
      .select({ id: posTokensSchema.id, name: posTokensSchema.deviceName })
      .from(posTokensSchema)
      .where(eq(posTokensSchema.organizationId, orgId))
      .orderBy(posTokensSchema.deviceName),
    db
      .select({ id: posUsersSchema.id, name: posUsersSchema.name })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.organizationId, orgId),
          eq(posUsersSchema.active, true),
        ),
      )
      .orderBy(posUsersSchema.name),
    db
      .select({ id: productsSchema.id, name: productsSchema.name })
      .from(productsSchema)
      .where(eq(productsSchema.organizationId, orgId))
      .orderBy(productsSchema.name),
  ]);

  return { registers, employees, products, returnPolicy };
}

export type ListSalesResult = {
  items: SaleListRow[];
  total: number;
};

export async function listSales(
  filters: ListSalesFilters = {},
): Promise<ListSalesResult> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const conds = [
    eq(salesSchema.organizationId, orgId),
    // Fully returned sales keep their row (status flips to 'returned'); they must
    // stay visible in the listing with the "Devuelta totalmente" badge, not vanish.
    inArray(salesSchema.status, ['completed', 'settled', 'returned'] as const),
  ];

  if (filters.start && filters.end) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date BETWEEN ${filters.start}::date AND ${filters.end}::date`,
    );
  } else if (filters.start) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date >= ${filters.start}::date`,
    );
  } else if (filters.end) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date <= ${filters.end}::date`,
    );
  }

  const payment = filters.payment?.trim().toLowerCase();
  if (payment && payment !== 'all') {
    if (payment === 'efectivo') {
      const f = or(
        ilike(salesSchema.paymentType, '%efectivo%'),
        ilike(salesSchema.paymentType, '%cash%'),
      );
      if (f) {
        conds.push(f);
      }
    } else if (payment === 'transferencia') {
      const f = or(
        ilike(salesSchema.paymentType, '%transfer%'),
        ilike(salesSchema.paymentType, '%nequi%'),
        ilike(salesSchema.paymentType, '%daviplata%'),
        ilike(salesSchema.paymentType, '%banco%'),
      );
      if (f) {
        conds.push(f);
      }
    } else {
      conds.push(ilike(salesSchema.paymentType, `%${payment}%`));
    }
  }

  if (filters.cashierId && filters.cashierId.trim() !== '') {
    conds.push(eq(salesSchema.cashierId, filters.cashierId.trim()));
  }

  if (filters.posTokenId && filters.posTokenId.trim() !== '') {
    conds.push(eq(salesSchema.posTokenId, filters.posTokenId.trim()));
  }

  if (filters.productId && filters.productId.trim() !== '') {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(saleItemsSchema)
          .where(
            and(
              eq(saleItemsSchema.saleId, salesSchema.id),
              eq(saleItemsSchema.productId, filters.productId.trim()),
            ),
          ),
      ),
    );
  }

  if (filters.origin === 'pos') {
    conds.push(isNotNull(salesSchema.posTokenId));
  } else if (filters.origin === 'panel') {
    conds.push(isNull(salesSchema.posTokenId));
  }

  if (filters.returnState === 'clean') {
    conds.push(sql.raw(`NOT ${HAS_RETURN_SQL}`));
  } else if (filters.returnState === 'partial') {
    conds.push(sql.raw(`(${HAS_RETURN_SQL} AND NOT ${FULLY_RETURNED_SQL})`));
  } else if (filters.returnState === 'returned') {
    conds.push(sql.raw(FULLY_RETURNED_SQL));
  }

  const search = filters.search?.trim();
  if (search) {
    const like = `%${search}%`;
    const f = or(
      sql`${salesSchema.id}::text ILIKE ${like}`,
      sql`${salesSchema.saleNumber}::text ILIKE ${like}`,
      exists(
        db
          .select({ one: sql`1` })
          .from(saleItemsSchema)
          .where(
            and(
              eq(saleItemsSchema.saleId, salesSchema.id),
              ilike(saleItemsSchema.productName, like),
            ),
          ),
      ),
    );
    if (f) {
      conds.push(f);
    }
  }

  const whereClause = and(...conds);

  const [items, totalRow] = await Promise.all([
    db
      .select({
        ...getTableColumns(salesSchema),
        // NOTE: these correlated subqueries are written with LITERAL table refs
        // (sales.id, alias pr/pri/si) instead of drizzle column interpolation.
        // Interpolating ${table.column} inside sql`` renders the column UNqualified
        // (e.g. "id" not "sales"."id"); inside a subquery that bare "id" binds to
        // the INNER table's own id, so the correlation silently never matches and
        // the result is always false/0. Literal qualified names avoid that trap.
        hasReturn: sql<boolean>`EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)`,
        // Returned units (across all returns) >= sold units. Reason-agnostic, so
        // damaged full returns and totals reached via multiple partials both
        // count as fully returned even though the sale row stays 'completed'.
        fullyReturned: sql<boolean>`(
          EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)
          AND COALESCE((
            SELECT SUM(pri.qty)
            FROM pos_return_items pri
            JOIN sale_items si ON si.id = pri.sale_item_id
            WHERE si.sale_id = sales.id
          ), 0) >= COALESCE((
            SELECT SUM(si2.qty) FROM sale_items si2 WHERE si2.sale_id = sales.id
          ), 0)
        )`,
      })
      .from(salesSchema)
      .where(whereClause)
      .orderBy(desc(salesSchema.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(salesSchema)
      .where(whereClause),
  ]);

  const cashierMap = await resolveCashiers(
    items
      .map(it => it.cashierId)
      .filter((id): id is string => id != null && id !== ''),
  );

  const deviceMap = await resolveDeviceNames(
    items
      .map(it => it.posTokenId)
      .filter((id): id is string => id != null && id !== ''),
  );

  const enriched: SaleListRow[] = items.map(it => ({
    ...it,
    cashierName: it.cashierId
      ? (cashierMap.get(it.cashierId)?.name ?? null)
      : null,
    cashierImageUrl: it.cashierId
      ? (cashierMap.get(it.cashierId)?.imageUrl ?? null)
      : null,
    deviceName: it.posTokenId ? (deviceMap.get(it.posTokenId) ?? null) : null,
  }));

  return {
    items: enriched,
    total: totalRow[0]?.count ?? 0,
  };
}

// --- Sale detail --------------------------------------------------------------

export type SaleDetailItem = {
  id: string;
  productName: string;
  qty: number;
  price: string;
  subtotal: string;
  unitType: string;
  /** Units already returned across all returns of this line. */
  returnedQty: number;
};

export type SaleDetailPayment = {
  id: string;
  method: string;
  amount: string;
  changeGiven: string;
  reference: string | null;
};

export type SaleDetailReturn = {
  id: string;
  reason: string;
  refundMethod: string;
  totalRefunded: string;
  partial: boolean;
  createdAt: Date;
  cashierName: string | null;
  items: {
    productName: string;
    qty: number;
    refundAmount: string;
    disposition: string;
  }[];
};

export type SaleDetail = {
  id: string;
  saleNumber: number | null;
  status: string;
  createdAt: Date;
  total: string;
  paymentType: string;
  notes: string | null;
  einvoiceStatus: string;
  einvoiceNumber: string | null;
  /** Where the sale was made: a POS device or the web panel. */
  origin: 'pos' | 'panel';
  deviceName: string | null;
  cashierName: string | null;
  cashierImageUrl: string | null;
  items: SaleDetailItem[];
  payments: SaleDetailPayment[];
  returns: SaleDetailReturn[];
};

// Full audit view of one sale: who sold it, when, from which device, how it was
// paid, every line item with its returned units, and the complete returns trail.
export async function getSaleDetail(saleId: string): Promise<SaleDetail | null> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (!UUID_RE.test(saleId)) {
    return null;
  }

  const [sale] = await db
    .select()
    .from(salesSchema)
    .where(
      and(eq(salesSchema.id, saleId), eq(salesSchema.organizationId, orgId)),
    )
    .limit(1);

  if (!sale) {
    return null;
  }

  const [items, payments, returns] = await Promise.all([
    db
      .select({
        id: saleItemsSchema.id,
        productName: saleItemsSchema.productName,
        qty: saleItemsSchema.qty,
        price: saleItemsSchema.price,
        subtotal: saleItemsSchema.subtotal,
        unitType: saleItemsSchema.unitType,
        // Literal table refs — see the note on getSaleForReturn's identical query.
        returnedQty: sql<number>`COALESCE((
          SELECT SUM(pri.qty)
          FROM pos_return_items pri
          WHERE pri.sale_item_id = sale_items.id
        ), 0)::int`,
      })
      .from(saleItemsSchema)
      .where(eq(saleItemsSchema.saleId, saleId)),
    db
      .select({
        id: salePaymentsSchema.id,
        method: salePaymentsSchema.method,
        amount: salePaymentsSchema.amount,
        changeGiven: salePaymentsSchema.changeGiven,
        reference: salePaymentsSchema.reference,
      })
      .from(salePaymentsSchema)
      .where(eq(salePaymentsSchema.saleId, saleId)),
    db
      .select()
      .from(posReturnsSchema)
      .where(eq(posReturnsSchema.saleId, saleId))
      .orderBy(desc(posReturnsSchema.createdAt)),
  ]);

  const returnItems
    = returns.length > 0
      ? await db
          .select({
            returnId: posReturnItemsSchema.returnId,
            productName: posReturnItemsSchema.productName,
            qty: posReturnItemsSchema.qty,
            refundAmount: posReturnItemsSchema.refundAmount,
            disposition: posReturnItemsSchema.disposition,
          })
          .from(posReturnItemsSchema)
          .where(
            inArray(
              posReturnItemsSchema.returnId,
              returns.map(r => r.id),
            ),
          )
      : [];

  const cashierMap = await resolveCashiers(
    [sale.cashierId, ...returns.map(r => r.cashierId)].filter(
      (id): id is string => id != null && id !== '',
    ),
  );
  const deviceMap = await resolveDeviceNames(
    sale.posTokenId ? [sale.posTokenId] : [],
  );

  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    status: sale.status,
    createdAt: sale.createdAt,
    total: sale.total,
    paymentType: sale.paymentType,
    notes: sale.notes,
    einvoiceStatus: sale.einvoiceStatus,
    einvoiceNumber: sale.einvoiceNumber,
    origin: sale.posTokenId ? 'pos' : 'panel',
    deviceName: sale.posTokenId
      ? (deviceMap.get(sale.posTokenId) ?? null)
      : null,
    cashierName: sale.cashierId
      ? (cashierMap.get(sale.cashierId)?.name ?? null)
      : null,
    cashierImageUrl: sale.cashierId
      ? (cashierMap.get(sale.cashierId)?.imageUrl ?? null)
      : null,
    items,
    payments,
    returns: returns.map(r => ({
      id: r.id,
      reason: r.reason,
      refundMethod: r.refundMethod,
      totalRefunded: r.totalRefunded,
      partial: r.partial,
      createdAt: r.createdAt,
      cashierName: r.cashierId
        ? (cashierMap.get(r.cashierId)?.name ?? null)
        : null,
      items: returnItems
        .filter(ri => ri.returnId === r.id)
        .map(ri => ({
          productName: ri.productName,
          qty: ri.qty,
          refundAmount: ri.refundAmount,
          disposition: ri.disposition,
        })),
    })),
  };
}

// --- Returns ----------------------------------------------------------------

export type ReturnableItem = {
  id: string;
  productId: string;
  productName: string;
  qty: number;
  subtotal: string;
  unitType: string;
  /** Units already returned across previous returns of this line. */
  returnedQty: number;
};

export type SaleReturnDetail = {
  id: string;
  saleNumber: number | null;
  total: string;
  status: string;
  items: ReturnableItem[];
};

// Loads a single sale with its line items and how much of each has already been
// returned, so the return modal can cap quantities and grey out spent lines.
export async function getSaleForReturn(
  saleId: string,
): Promise<SaleReturnDetail> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const [sale] = await db
    .select({
      id: salesSchema.id,
      saleNumber: salesSchema.saleNumber,
      total: salesSchema.total,
      status: salesSchema.status,
    })
    .from(salesSchema)
    .where(
      and(eq(salesSchema.id, saleId), eq(salesSchema.organizationId, orgId)),
    )
    .limit(1);

  if (!sale) {
    throw new Error('Venta no encontrada');
  }

  const items = await db
    .select({
      id: saleItemsSchema.id,
      productId: saleItemsSchema.productId,
      productName: saleItemsSchema.productName,
      qty: saleItemsSchema.qty,
      subtotal: saleItemsSchema.subtotal,
      unitType: saleItemsSchema.unitType,
      // Literal table refs (alias pri + outer sale_items.id), NOT drizzle column
      // interpolation: ${table.column} renders unqualified inside sql``, so a bare
      // "id" in this correlated subquery would bind to pos_return_items' own id
      // and the SUM would always be 0 (the bug that showed initial, not remaining,
      // units in the return modal).
      returnedQty: sql<number>`COALESCE((
        SELECT SUM(pri.qty)
        FROM pos_return_items pri
        WHERE pri.sale_item_id = sale_items.id
      ), 0)::int`,
    })
    .from(saleItemsSchema)
    .where(eq(saleItemsSchema.saleId, saleId));

  return { ...sale, items };
}

export type ProcessReturnInput = {
  reason: ReturnReason;
  refundMethod: string;
  items: {
    saleItemId: string;
    qty: number;
    refundAmount: number;
    disposition?: ReturnDisposition;
  }[];
  notes?: string | null;
  partial: boolean;
};

// Best-effort human label for the admin who ran the return, mirroring the
// resolution used by the Caja actions (cash.ts:getActorName).
async function resolveAdminName(fallback: string): Promise<string> {
  try {
    const user = await currentUser();
    const candidate
      = user?.fullName
        || [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
        || user?.username
        || user?.primaryEmailAddress?.emailAddress;
    return candidate && candidate.length > 0 ? candidate : fallback;
  } catch {
    return fallback;
  }
}

// Processes a sale return from the dashboard (Clerk admin). Shares the
// money/stock/cash core with the POS route via applySaleReturn; the admin is
// not a pos_user, so cashierId is null and the audit trail carries the actor.
export async function processReturn(saleId: string, input: ProcessReturnInput) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const actorName = await resolveAdminName(userId);

  const result = await db.transaction(tx =>
    applySaleReturn(tx, {
      saleId,
      organizationId: orgId,
      cashierId: null,
      actorName,
      authorizedByAdmin: orgRole === 'org:admin',
      reason: input.reason,
      refundMethod: input.refundMethod,
      items: input.items,
      notes: input.notes ?? null,
      partial: input.partial,
    }),
  );

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'sale.returned',
    entityType: 'pos_return',
    entityId: result.id,
    after: {
      returnId: result.id,
      saleId,
      totalRefunded: result.totalRefunded,
      partial: result.partial,
      itemCount: result.items.length,
    },
    metadata: {
      reason: input.reason,
      refundMethod: input.refundMethod,
      partial: result.partial,
      source: 'dashboard',
    },
  });

  revalidatePath('/dashboard/sales');
  revalidatePath('/dashboard/products');
  revalidatePath('/dashboard/cash');

  // Best-effort: void the electronic invoice with a credit note when the sale
  // was emitted. No-op if the sale had no CUFE.
  void maybeEmitCreditNote(orgId, saleId, input.reason);

  return result;
}

// --- Caja saturation signal -------------------------------------------------
// "This register works a lot → buy/activate another caja" is measured by the
// REST between consecutive sales, not by raw daily volume. A tiny gap means the
// cashier never gets breathing room — the honest bottleneck signal, and it is
// auto-normalized across business types (a bakery and a supermarket each have
// their own comfortable rhythm; sales/day would need a different threshold per
// business, the inter-sale gap does not).
const SATURATION_WINDOW_DAYS = 30;
// Gaps longer than this are treated as "store closed / long pause" and excluded
// from the median, so an overnight gap can't inflate it and hide midday rush.
const SATURATION_CLOSED_GAP_SECONDS = 60 * 60; // 1h
// Median gap at or below this ⇒ the caja is saturated.
const SATURATION_MEDIAN_THRESHOLD_SECONDS = 2 * 60; // 2min
// Don't judge saturation on thin data — a median over a handful of sales lies.
const SATURATION_MIN_SALES = 20;

export type CajaSaturation = {
  posTokenId: string;
  deviceName: string | null;
  salesCount: number;
  medianGapSeconds: number | null;
  saturated: boolean;
};

export type SaturationReport = {
  // True when at least one caja is at its working limit.
  saturated: boolean;
  cajas: CajaSaturation[];
};

// Per-caja saturation over the trailing window. One SQL pass: LAG() yields the
// gap to the previous sale on the same caja, percentile_cont(0.5) the median of
// the gaps that fall under the closed-store cutoff, and the HAVING clause drops
// cajas with too few sales to judge.
export async function getCashierSaturation(): Promise<SaturationReport> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No active organization');
  }

  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        ${salesSchema.posTokenId} AS pos_token_id,
        EXTRACT(EPOCH FROM (
          ${salesSchema.createdAt}
          - LAG(${salesSchema.createdAt}) OVER (
              PARTITION BY ${salesSchema.posTokenId}
              ORDER BY ${salesSchema.createdAt}
            )
        )) AS gap_seconds
      FROM ${salesSchema}
      WHERE ${salesSchema.organizationId} = ${orgId}
        AND ${salesSchema.status} IN ('completed', 'settled')
        AND ${salesSchema.posTokenId} IS NOT NULL
        AND ${salesSchema.createdAt}
            >= now() - make_interval(days => ${SATURATION_WINDOW_DAYS})
    )
    SELECT
      b.pos_token_id AS "posTokenId",
      t.device_name AS "deviceName",
      count(*)::int AS "salesCount",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY b.gap_seconds)
        FILTER (
          WHERE b.gap_seconds IS NOT NULL
            AND b.gap_seconds <= ${SATURATION_CLOSED_GAP_SECONDS}
        ) AS "medianGapSeconds"
    FROM base b
    LEFT JOIN ${posTokensSchema} t ON t.id = b.pos_token_id
    GROUP BY b.pos_token_id, t.device_name
    HAVING count(*) >= ${SATURATION_MIN_SALES}
  `);

  const rows = result.rows as Array<{
    posTokenId: string;
    deviceName: string | null;
    salesCount: number | string;
    medianGapSeconds: number | string | null;
  }>;

  const cajas: CajaSaturation[] = rows.map((row) => {
    const median
      = row.medianGapSeconds == null ? null : Number(row.medianGapSeconds);
    return {
      posTokenId: row.posTokenId,
      deviceName: row.deviceName,
      salesCount: Number(row.salesCount),
      medianGapSeconds: median,
      saturated:
        median != null && median <= SATURATION_MEDIAN_THRESHOLD_SECONDS,
    };
  });

  return {
    saturated: cajas.some(c => c.saturated),
    cajas,
  };
}
