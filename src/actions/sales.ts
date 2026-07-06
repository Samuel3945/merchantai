'use server';

import type { SQL } from 'drizzle-orm';
import type { CajaSales, SaturationConfig } from '@/libs/caja-saturation';
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
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import {
  computeSaturationReport,
  DEFAULT_SATURATION_CONFIG,
} from '@/libs/caja-saturation';
import { recordCashMovement } from '@/libs/cash-helpers';
import { createCredito } from '@/libs/creditos';
import { creditoAmountFor, isCreditoMethod } from '@/libs/creditos-math';
import { db } from '@/libs/DB';
import {
  maybeAutoEmitInvoice,
  maybeEmitCreditNote,
} from '@/libs/einvoice/emit';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { getOrgTimezone } from '@/libs/org-timezone';
import { getCurrentPanelUser } from '@/libs/panel-session';
import { loadReturnPolicy } from '@/libs/return-policy';
import { assignNextSaleNumber } from '@/libs/sale-number';
import { applySaleReturn } from '@/libs/sale-returns';
import { recordSaleTransferReconciliations } from '@/libs/transfer-reconciliation';
import { wholesaleUnitPrice } from '@/libs/wholesale';
import {
  cajasSchema,
  creditoMovementsSchema,
  creditosSchema,
  deliveryEventsSchema,
  deliveryOrdersSchema,
  orgAddressesSchema,
  posReturnItemsSchema,
  posReturnsSchema,
  posTokensSchema,
  posUsersSchema,
  productsSchema,
  saleItemsSchema,
  salePaymentsSchema,
  salesSchema,
  stockMovementsSchema,
  transferReconciliationsSchema,
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
  // For credito sales: optional manual due date ('YYYY-MM-DD'). When omitted, the
  // org default term applies (creditos.default_term_days, 30 by default).
  dueDate?: string | null;
};

// Org-scoped core, decoupled from Clerk auth so it can run from the dashboard
// server action (createSale, below) OR from an agent API route without a
// session (POST /api/agent/orders). The caller supplies the resolved orgId and
// actor identity — never trust a request body for either.
//
// HARD CONTRACT: when posTokenId/idempotencyKey are omitted, this must behave
// BYTE-FOR-BYTE like the original createSale body (same insert shape, same
// recordCashMovement(saleId, total) call signature with no ctx argument).
export type CreateSaleForOrgInput = {
  orgId: string;
  // Clerk userId for the dashboard; ctx.tokenId ?? ctx.channelId for the agent.
  actorId: string;
  actorType?: 'user' | 'api';
  items: { productId: string; qty: number }[];
  paymentType: string;
  payments?: SalePaymentInput[];
  notes?: string | null;
  dueDate?: string | null;
  // Stamped on the sale row. Omitted (undefined) = dashboard, unchanged
  // behavior. null = agent sale attributed to the admin/no-device cash
  // session. A uuid = agent sale attributed to that POS device's session.
  posTokenId?: string | null;
  // Explicit sale origin (see saleChannelEnum in Schema.ts). Omitted =
  // inferred from posTokenId, same as before this field existed: 'pos' when
  // a device is attached, 'panel' otherwise.
  channel?: 'pos' | 'panel' | 'delivery' | 'agent';
  // Links the sale (and, for a fiado, its credito) to a known customer. Omitted
  // = anonymous sale, customer_id stays NULL. Threaded from the delivery order's
  // customerId at settlement; invoice-tagged sales stamp it post-commit instead.
  customerId?: string | null;
  // Sets sale_idempotency_key. Omitted = no dedupe (dashboard, unchanged).
  idempotencyKey?: string;
};

function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

/** True when the error is a Postgres unique-constraint violation (23505). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code: unknown }).code === '23505'
  );
}

export async function createSaleForOrg(input: CreateSaleForOrgInput) {
  const { orgId, actorId } = input;
  const actorType = input.actorType ?? 'user';

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

  let deduped = false;
  let result: typeof salesSchema.$inferSelect & {
    items: (typeof saleItemsSchema.$inferSelect)[];
    payments: (typeof salePaymentsSchema.$inferSelect)[];
  };

  try {
    result = await db.transaction(async (tx) => {
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
      // Digital products skip the stock decrement below; their availability is
      // the optional digitalLimit counter instead of physical stock.
      const digitalById = new Map<string, { digitalLimit: number | null }>();

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

        if (product.isDigital) {
          digitalById.set(product.id, { digitalLimit: product.digitalLimit });
          if (product.digitalLimit !== null && product.digitalLimit < item.qty) {
            throw new Error(
              `Límite de ventas alcanzado para "${product.name}" (disponible: ${product.digitalLimit}, solicitado: ${item.qty})`,
            );
          }
        } else if (product.stock < item.qty) {
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
          cashierId: actorId,
          posTokenId: input.posTokenId ?? null,
          channel: input.channel ?? (input.posTokenId ? 'pos' : 'panel'),
          customerId: input.customerId ?? null,
          saleIdempotencyKey: input.idempotencyKey ?? undefined,
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
        actorId,
        sale.id,
        itemsToInsert.map((it, i) => ({
          productId: it.productId,
          productName: it.productName,
          qty: it.qty,
          fallbackCost: lineFallbackCost[i] ?? '0',
        })),
      );

      // Stock on hand stays the authoritative quantity; the FIFO ledger above
      // mirrors it batch by batch. Digital products keep stock at 0 and consume
      // their sales-limit counter instead (no-op when unlimited).
      for (const item of input.items) {
        const digital = digitalById.get(item.productId);
        if (digital) {
          if (digital.digitalLimit !== null) {
            await tx
              .update(productsSchema)
              .set({
                digitalLimit: sql`GREATEST(0, ${productsSchema.digitalLimit} - ${item.qty})`,
              })
              .where(
                and(
                  eq(productsSchema.id, item.productId),
                  eq(productsSchema.organizationId, orgId),
                ),
              );
          }
          continue;
        }
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

      // Credito: book the credit account for the portion NOT covered by an upfront
      // non-credito payment. A 100%-credito sale owes the full total; a split sale
      // (e.g. part efectivo now, rest credito) owes only the remainder. The efectivo
      // part still hits the drawer via recordCashMovement below.
      const creditoAmount = creditoAmountFor(total, paymentRows);
      const isCredito
        = isCreditoMethod(input.paymentType)
          || paymentRows.some(p => isCreditoMethod(p.method));
      if (isCredito && creditoAmount > 0) {
        await createCredito(tx, {
          organizationId: orgId,
          saleId: sale.id,
          originalAmount: creditoAmount,
          dueDate: input.dueDate ?? null,
          customerId: input.customerId ?? null,
          createdBy: actorId,
          notes: input.notes ?? null,
        });
      }

      return { ...sale, items: insertedItems, payments: insertedPayments };
    });
  } catch (err) {
    // Belt-and-suspenders idempotency: a concurrent retry with the same
    // idempotencyKey can lose the race on the partial unique index
    // (organization_id, sale_idempotency_key). The whole transaction rolls
    // back on that error (no partial writes, no double stock decrement) — so
    // it's safe to just re-read the winner and return it instead of throwing.
    if (input.idempotencyKey && isUniqueConstraintViolation(err)) {
      const [existing] = await db
        .select()
        .from(salesSchema)
        .where(
          and(
            eq(salesSchema.organizationId, orgId),
            eq(salesSchema.saleIdempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) {
        throw err;
      }
      const [items, payments] = await Promise.all([
        db
          .select()
          .from(saleItemsSchema)
          .where(eq(saleItemsSchema.saleId, existing.id)),
        db
          .select()
          .from(salePaymentsSchema)
          .where(eq(salePaymentsSchema.saleId, existing.id)),
      ]);
      deduped = true;
      result = { ...existing, items, payments };
    } else {
      throw err;
    }
  }

  if (!deduped) {
    // Best-effort, exactly like the POS sale route: the sale transaction has
    // already committed. A throw here would reject the caller AFTER a
    // committed sale, so the operator/agent sees an error and retries —
    // creating a DUPLICATE sale (double stock decrement, double revenue). A
    // dropped cash movement only understates the drawer (reconciled at
    // closing), which is far less harmful.
    //
    // posTokenId omitted (dashboard, unchanged): same no-ctx call as before,
    // resolved from the current Clerk session inside recordCashMovement.
    // posTokenId provided (agent path): book into THAT device's (or the
    // admin, when null) session explicitly — there is no Clerk session here.
    if (input.posTokenId !== undefined) {
      await recordCashMovement(result.id, result.total, {
        organizationId: orgId,
        userId: actorId,
        posTokenId: input.posTokenId,
      }).catch(() => null);
    } else {
      await recordCashMovement(result.id, result.total).catch(() => null);
    }

    // Mirror for non-cash money: feed the transfer reconciliation ledger so the
    // digital collections can be confirmed against the account later. Same
    // best-effort contract — a failure must never reject a committed sale.
    await recordSaleTransferReconciliations(result.id).catch(() => null);

    // Best-effort: emit the electronic invoice now if a provider is configured.
    // Never awaited into the response — the sale already succeeded; a failed
    // emission stays retriable from the Facturas module.
    void maybeAutoEmitInvoice(orgId, result.id);

    await logAction({
      organizationId: orgId,
      actor: { type: actorType, id: actorId },
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
  }

  return { ...result, deduped };
}

export async function createSale(input: CreateSaleInput) {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  // Dashboard callers never pass posTokenId/idempotencyKey, so createSaleForOrg
  // takes its byte-for-byte-identical-to-today branch (no ctx to
  // recordCashMovement, no dedupe). `deduped` is stripped here so the returned
  // shape stays exactly what callers of createSale got before this extraction.
  const { deduped: _deduped, ...result } = await createSaleForOrg({
    orgId,
    actorId: userId,
    actorType: 'user',
    items: input.items,
    paymentType: input.paymentType,
    payments: input.payments,
    notes: input.notes,
    dueDate: input.dueDate,
    // Explicit even though omitting posTokenId already defaults to 'panel' —
    // this IS the dashboard-manual creation path, so make it unambiguous.
    channel: 'panel',
  });

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
  // Nombre del domiciliario (solo ventas de canal 'delivery'). Null en las demás.
  courierName: string | null;
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

// Resuelve el nombre del domiciliario por venta (canal delivery) en un lote:
// delivery_orders(sale_id) → courier_id → pos_users.name. Result: Map<saleId, name>.
async function resolveCourierNames(
  saleIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(saleIds.filter(Boolean))];
  if (unique.length === 0) {
    return map;
  }
  const rows = await db
    .select({
      saleId: deliveryOrdersSchema.saleId,
      name: posUsersSchema.name,
    })
    .from(deliveryOrdersSchema)
    .innerJoin(
      posUsersSchema,
      eq(deliveryOrdersSchema.courierId, posUsersSchema.id),
    )
    .where(inArray(deliveryOrdersSchema.saleId, unique));
  for (const r of rows) {
    if (r.saleId) {
      map.set(r.saleId, r.name);
    }
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
  /** Filter by the exact POS device (pos_tokens.id) the sale was made on. */
  posTokenId?: string | null;
  /** Filter by the logical caja (bolsa): every device whose pos_tokens.caja_id matches. */
  cajaId?: string | null;
  /** Filter sales containing a specific product. */
  productId?: string | null;
  /** Channel bucket: 'delivery' = home delivery, 'pos' = everything else. */
  channel?: 'all' | 'pos' | 'delivery' | null;
  /**
   * Return state, by quantity (same rule as the listing badges). 'any' matches
   * every sale that has at least one return (partial OR total).
   */
  returnState?: 'all' | 'clean' | 'partial' | 'returned' | 'any' | null;
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

// The single source of truth for "which sales are in scope" — shared by the
// listing (listSales) and the period KPIs (getSalesSummary) so the cards on top
// always reflect the exact same filter set as the rows below them. scopedCashierId
// is resolved by the caller (a non-owner employee is forced to their own sales).
function buildSalesConds(
  orgId: string,
  scopedCashierId: string | null,
  filters: ListSalesFilters,
): SQL[] {
  const conds: SQL[] = [
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

  // A scoped employee always wins over the requested cashier filter.
  const effectiveCashierId
    = scopedCashierId ?? (filters.cashierId?.trim() || null);
  if (effectiveCashierId) {
    conds.push(eq(salesSchema.cashierId, effectiveCashierId));
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

  // Caja (bolsa): match sales made on any device that belongs to the caja.
  if (filters.cajaId && filters.cajaId.trim() !== '') {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(posTokensSchema)
          .where(
            and(
              eq(posTokensSchema.id, salesSchema.posTokenId),
              eq(posTokensSchema.cajaId, filters.cajaId.trim()),
            ),
          ),
      ),
    );
  }

  // Channel: home delivery vs everything else (pos/panel/agent).
  if (filters.channel === 'delivery') {
    conds.push(eq(salesSchema.channel, 'delivery'));
  } else if (filters.channel === 'pos') {
    conds.push(ne(salesSchema.channel, 'delivery'));
  }

  if (filters.returnState === 'clean') {
    conds.push(sql.raw(`NOT ${HAS_RETURN_SQL}`));
  } else if (filters.returnState === 'partial') {
    conds.push(sql.raw(`(${HAS_RETURN_SQL} AND NOT ${FULLY_RETURNED_SQL})`));
  } else if (filters.returnState === 'returned') {
    conds.push(sql.raw(FULLY_RETURNED_SQL));
  } else if (filters.returnState === 'any') {
    // Any sale with at least one return, partial or total.
    conds.push(sql.raw(HAS_RETURN_SQL));
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

  return conds;
}

// Lightweight, org-scoped option lists for the sales filter bar: every POS
// register, every active employee, and the product catalog. One round trip.
export type SalesFilterOptions = {
  /** Logical cajas (bolsas) of type 'register', not archived. */
  cajas: { id: string; name: string }[];
  /** Physical POS devices (pos_tokens), by device name. */
  devices: { id: string; name: string }[];
  employees: { id: string; name: string }[];
  products: { id: string; name: string }[];
  /** Return rules so the listing can disable "Devolver" up front. */
  returnPolicy: ReturnPolicy;
};

export async function getSalesFilterOptions(): Promise<SalesFilterOptions> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const returnPolicy = await loadReturnPolicy(db, orgId);

  // A non-owner employee only ever sees their own sales, so the cashier filter
  // must list just themselves — never their colleagues' names.
  const employeeConds = [
    eq(posUsersSchema.organizationId, orgId),
    eq(posUsersSchema.active, true),
  ];
  if (orgRole !== 'org:admin') {
    employeeConds.push(eq(posUsersSchema.clerkUserId, userId));
  }

  const [cajas, devices, employees, products] = await Promise.all([
    db
      .select({ id: cajasSchema.id, name: cajasSchema.name })
      .from(cajasSchema)
      .where(
        and(
          eq(cajasSchema.organizationId, orgId),
          eq(cajasSchema.type, 'register'),
          eq(cajasSchema.archived, false),
        ),
      )
      .orderBy(cajasSchema.name),
    db
      .select({ id: posTokensSchema.id, name: posTokensSchema.deviceName })
      .from(posTokensSchema)
      .where(eq(posTokensSchema.organizationId, orgId))
      .orderBy(posTokensSchema.deviceName),
    db
      .select({ id: posUsersSchema.id, name: posUsersSchema.name })
      .from(posUsersSchema)
      .where(and(...employeeConds))
      .orderBy(posUsersSchema.name),
    db
      .select({ id: productsSchema.id, name: productsSchema.name })
      .from(productsSchema)
      .where(eq(productsSchema.organizationId, orgId))
      .orderBy(productsSchema.name),
  ]);

  return { cajas, devices, employees, products, returnPolicy };
}

export type ListSalesResult = {
  items: SaleListRow[];
  total: number;
};

export async function listSales(
  filters: ListSalesFilters = {},
): Promise<ListSalesResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  // Non-owner employees are scoped to their OWN sales: we force the cashier
  // filter to their linked pos_users id and ignore any incoming cashierId so it
  // cannot be spoofed. An employee with no active linked user sees nothing.
  let scopedCashierId: string | null = null;
  if (orgRole !== 'org:admin') {
    const me = await getCurrentPanelUser(userId, orgId);
    if (!me) {
      return { items: [], total: 0 };
    }
    scopedCashierId = me.id;
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const conds = buildSalesConds(orgId, scopedCashierId, filters);

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

  const courierMap = await resolveCourierNames(
    items.filter(it => it.channel === 'delivery').map(it => it.id),
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
    courierName:
      it.channel === 'delivery' ? (courierMap.get(it.id) ?? null) : null,
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

export type SaleDetailDeliveryEvent = {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  createdAt: Date;
};

export type SaleDetailDelivery = {
  status: string;
  address: string | null;
  courierName: string | null;
  events: SaleDetailDeliveryEvent[];
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
  /** Delivery process (status timeline), present only for channel === 'delivery' sales. */
  delivery: SaleDetailDelivery | null;
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

  // Delivery process: only sales stamped channel = 'delivery' have a linked
  // delivery order. Best-effort — if the order/events are missing for any
  // reason, the sale detail still renders without the delivery section.
  let delivery: SaleDetailDelivery | null = null;
  if (sale.channel === 'delivery') {
    const [order] = await db
      .select()
      .from(deliveryOrdersSchema)
      .where(
        and(
          eq(deliveryOrdersSchema.saleId, sale.id),
          eq(deliveryOrdersSchema.organizationId, orgId),
        ),
      )
      .limit(1);

    if (order) {
      const events = await db
        .select({
          type: deliveryEventsSchema.type,
          fromStatus: deliveryEventsSchema.fromStatus,
          toStatus: deliveryEventsSchema.toStatus,
          note: deliveryEventsSchema.note,
          createdAt: deliveryEventsSchema.createdAt,
        })
        .from(deliveryEventsSchema)
        .where(
          and(
            eq(deliveryEventsSchema.deliveryOrderId, order.id),
            eq(deliveryEventsSchema.organizationId, orgId),
          ),
        )
        .orderBy(deliveryEventsSchema.createdAt);

      let courierName: string | null = null;
      if (order.courierId) {
        const [courier] = await db
          .select({ name: posUsersSchema.name })
          .from(posUsersSchema)
          .where(eq(posUsersSchema.id, order.courierId))
          .limit(1);
        courierName = courier?.name ?? null;
      }

      delivery = {
        status: order.status,
        address: order.address,
        courierName,
        events,
      };
    }
  }

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
    delivery,
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
  damagedResolution?: 'replace' | 'refund';
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
      damagedResolution: input.damagedResolution,
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
// The whole judgement ("is this register saturated often enough to deserve a
// second caja?") lives in the pure model at libs/caja-saturation.ts: peak 2h
// window utilization, effort measured by cart lines, recurrence across days.
// This action only feeds it real data — per-sale line counts over the trailing
// window, grouped by caja — and returns its verdict.
//
// Business time = created_at for now. On the always-online web POS that equals
// the real sale time. When the native app ships its offline queue, persist the
// device's real timestamp into an occurred_at column and read it here instead;
// the model already measures on occurredAt, so nothing else changes.
export type { CajaSaturationResult, SaturationReport } from '@/libs/caja-saturation';

export async function getCashierSaturation(
  config: SaturationConfig = DEFAULT_SATURATION_CONFIG,
): Promise<Awaited<ReturnType<typeof computeSaturationReport>>> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No active organization');
  }

  // Days are cut in the org's own timezone (chosen at onboarding, immutable),
  // so saturation is correct as we grow internationally — not pinned to Bogotá.
  const effectiveConfig: SaturationConfig = {
    ...config,
    timezone: await getOrgTimezone(orgId),
  };

  // One row per sale with its cart-line count, joined to its device name.
  const result = await db.execute(sql`
    SELECT
      ${salesSchema.posTokenId} AS "posTokenId",
      ${posTokensSchema.deviceName} AS "deviceName",
      ${orgAddressesSchema.name} AS "sede",
      ${salesSchema.occurredAt} AS "occurredAt",
      count(${saleItemsSchema.id})::int AS "lineCount"
    FROM ${salesSchema}
    LEFT JOIN ${saleItemsSchema}
      ON ${saleItemsSchema.saleId} = ${salesSchema.id}
    LEFT JOIN ${posTokensSchema}
      ON ${posTokensSchema.id} = ${salesSchema.posTokenId}
    LEFT JOIN ${orgAddressesSchema}
      ON ${orgAddressesSchema.id} = ${posTokensSchema.addressId}
    WHERE ${salesSchema.organizationId} = ${orgId}
      AND ${salesSchema.status} IN ('completed', 'settled')
      AND ${salesSchema.posTokenId} IS NOT NULL
      AND ${salesSchema.occurredAt}
          >= now() - make_interval(days => ${effectiveConfig.windowDays})
    GROUP BY
      ${salesSchema.id},
      ${salesSchema.posTokenId},
      ${posTokensSchema.deviceName},
      ${orgAddressesSchema.name},
      ${salesSchema.occurredAt}
  `);

  const rows = result.rows as Array<{
    posTokenId: string;
    deviceName: string | null;
    sede: string | null;
    occurredAt: string | Date;
    lineCount: number | string;
  }>;

  // Fold the flat rows into one CajaSales bucket per device.
  const byCaja = new Map<string, CajaSales>();
  for (const row of rows) {
    let caja = byCaja.get(row.posTokenId);
    if (!caja) {
      caja = {
        posTokenId: row.posTokenId,
        deviceName: row.deviceName,
        sede: row.sede,
        sales: [],
      };
      byCaja.set(row.posTokenId, caja);
    }
    caja.sales.push({
      occurredAt: new Date(row.occurredAt),
      lineCount: Number(row.lineCount),
    });
  }

  return computeSaturationReport([...byCaja.values()], effectiveConfig);
}

// --- Period KPIs --------------------------------------------------------------

export type SalesSummary = {
  /** SUM of sale totals in the filtered range (gross, before refunds). */
  soldGross: number;
  salesCount: number;
  /** soldGross / salesCount, 0 when the range has no sales. */
  avgTicket: number;
  /** Refunds tied to sales in the range. */
  refundedTotal: number;
  refundCount: number;
  /** How customers paid: physical cash vs everything digital. */
  cashPaid: number;
  digitalPaid: number;
  /** Busiest local hour (0-23) by sale count, null when the range is empty. */
  peakHour: number | null;
  peakHourCount: number;
  /** Per-day sold totals (Bogota date, ascending) for the headline sparkline. */
  daily: { day: string; total: number }[];
};

const EMPTY_SUMMARY: SalesSummary = {
  soldGross: 0,
  salesCount: 0,
  avgTicket: 0,
  refundedTotal: 0,
  refundCount: 0,
  cashPaid: 0,
  digitalPaid: 0,
  peakHour: null,
  peakHourCount: 0,
  daily: [],
};

// Aggregate the SAME filtered sale set the listing shows — never the visible
// page. The cards on top and the rows below answer to one WHERE clause
// (buildSalesConds), so a period filter moves both together.
export async function getSalesSummary(
  filters: ListSalesFilters = {},
): Promise<SalesSummary> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  let scopedCashierId: string | null = null;
  if (orgRole !== 'org:admin') {
    const me = await getCurrentPanelUser(userId, orgId);
    if (!me) {
      return EMPTY_SUMMARY;
    }
    scopedCashierId = me.id;
  }

  const where = and(...buildSalesConds(orgId, scopedCashierId, filters));

  const [base, refunds, split, peak, daily] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        sold: sql<number>`COALESCE(SUM(${salesSchema.total}), 0)::float8`,
      })
      .from(salesSchema)
      .where(where),
    db
      .select({
        refunded: sql<number>`COALESCE(SUM(${posReturnsSchema.totalRefunded}), 0)::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(posReturnsSchema)
      .innerJoin(salesSchema, eq(posReturnsSchema.saleId, salesSchema.id))
      .where(where),
    db
      .select({
        cash: sql<number>`COALESCE(SUM(CASE WHEN ${salePaymentsSchema.method} ILIKE '%efectivo%' OR ${salePaymentsSchema.method} ILIKE '%cash%' THEN ${salePaymentsSchema.amount} ELSE 0 END), 0)::float8`,
        total: sql<number>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::float8`,
      })
      .from(salePaymentsSchema)
      .innerJoin(salesSchema, eq(salePaymentsSchema.saleId, salesSchema.id))
      .where(where),
    db
      .select({
        hour: sql<number>`EXTRACT(HOUR FROM (${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'))::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(salesSchema)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`2 DESC`)
      .limit(1),
    db
      .select({
        day: sql<string>`to_char((${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD')`,
        total: sql<number>`COALESCE(SUM(${salesSchema.total}), 0)::float8`,
      })
      .from(salesSchema)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);

  const soldGross = base[0]?.sold ?? 0;
  const salesCount = base[0]?.count ?? 0;
  const cashPaid = split[0]?.cash ?? 0;
  const totalPaid = split[0]?.total ?? 0;

  return {
    soldGross,
    salesCount,
    avgTicket: salesCount > 0 ? soldGross / salesCount : 0,
    refundedTotal: refunds[0]?.refunded ?? 0,
    refundCount: refunds[0]?.count ?? 0,
    cashPaid,
    digitalPaid: Math.max(0, totalPaid - cashPaid),
    peakHour: peak[0]?.hour ?? null,
    peakHourCount: peak[0]?.count ?? 0,
    daily: daily.map(d => ({ day: d.day, total: d.total })),
  };
}

// --- Sale timeline ------------------------------------------------------------

export type SaleTimelineTone
  = 'neutral' | 'success' | 'warning' | 'danger' | 'eco';

export type SaleTimelineEvent = {
  id: string;
  kind:
    | 'sale_created'
    | 'payment'
    | 'transfer_pending'
    | 'transfer_confirmed'
    | 'transfer_partial'
    | 'transfer_not_arrived'
    | 'transfer_to_credito'
    | 'transfer_loss'
    | 'cashier_explained'
    | 'credito_opened'
    | 'credito_abono'
    | 'credito_extended'
    | 'credito_writeoff'
    | 'credito_paid'
    | 'return';
  /** ISO timestamp; the UI sorts and formats it. */
  at: string;
  title: string;
  detail: string | null;
  /** Numeric string when the beat moves money, else null. */
  amount: string | null;
  tone: SaleTimelineTone;
};

// The full lifecycle of ONE sale, projected read-only over the ledgers that
// already record it: the sale and its payments, the transfer-reconciliation
// trail (confirmed / partial / not arrived / loss / converted to credito), the
// credito debt and its abonos, and any returns. No new table — every beat is
// reconstructed from existing rows and returned oldest-first.
export async function getSaleTimeline(
  saleId: string,
): Promise<SaleTimelineEvent[]> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (!UUID_RE.test(saleId)) {
    return [];
  }

  const copFmt = new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
  const money = (v: string | number) =>
    copFmt.format(typeof v === 'number' ? v : Number.parseFloat(v) || 0);

  const [sale] = await db
    .select({
      id: salesSchema.id,
      createdAt: salesSchema.createdAt,
      total: salesSchema.total,
      paymentType: salesSchema.paymentType,
    })
    .from(salesSchema)
    .where(
      and(eq(salesSchema.id, saleId), eq(salesSchema.organizationId, orgId)),
    )
    .limit(1);

  if (!sale) {
    return [];
  }

  const [payments, returns, creditos] = await Promise.all([
    db
      .select({
        id: salePaymentsSchema.id,
        method: salePaymentsSchema.method,
        amount: salePaymentsSchema.amount,
        createdAt: salePaymentsSchema.createdAt,
      })
      .from(salePaymentsSchema)
      .where(eq(salePaymentsSchema.saleId, saleId)),
    db
      .select({
        id: posReturnsSchema.id,
        totalRefunded: posReturnsSchema.totalRefunded,
        refundMethod: posReturnsSchema.refundMethod,
        partial: posReturnsSchema.partial,
        createdAt: posReturnsSchema.createdAt,
      })
      .from(posReturnsSchema)
      .where(eq(posReturnsSchema.saleId, saleId)),
    db
      .select({
        id: creditosSchema.id,
        originalAmount: creditosSchema.originalAmount,
        status: creditosSchema.status,
        dueDate: creditosSchema.dueDate,
        createdAt: creditosSchema.createdAt,
      })
      .from(creditosSchema)
      .where(eq(creditosSchema.saleId, saleId)),
  ]);

  const paymentIds = payments.map(p => p.id);
  const creditoIds = creditos.map(f => f.id);

  const transfers = paymentIds.length > 0
    ? await db
        .select({
          id: transferReconciliationsSchema.id,
          method: transferReconciliationsSchema.method,
          expectedAmount: transferReconciliationsSchema.expectedAmount,
          arrivedAmount: transferReconciliationsSchema.arrivedAmount,
          status: transferReconciliationsSchema.status,
          reconciledAt: transferReconciliationsSchema.reconciledAt,
          resolvedAt: transferReconciliationsSchema.resolvedAt,
          resolutionType: transferReconciliationsSchema.resolutionType,
          resolutionCreditoId: transferReconciliationsSchema.resolutionCreditoId,
          cashierExplainedAt: transferReconciliationsSchema.cashierExplainedAt,
          cashierExplanation: transferReconciliationsSchema.cashierExplanation,
          createdAt: transferReconciliationsSchema.createdAt,
        })
        .from(transferReconciliationsSchema)
        .where(
          inArray(transferReconciliationsSchema.salePaymentId, paymentIds),
        )
    : [];

  const movements = creditoIds.length > 0
    ? await db
        .select({
          id: creditoMovementsSchema.id,
          creditoId: creditoMovementsSchema.creditoId,
          type: creditoMovementsSchema.type,
          amount: creditoMovementsSchema.amount,
          method: creditoMovementsSchema.method,
          dueDateBefore: creditoMovementsSchema.dueDateBefore,
          dueDateAfter: creditoMovementsSchema.dueDateAfter,
          createdAt: creditoMovementsSchema.createdAt,
        })
        .from(creditoMovementsSchema)
        .where(inArray(creditoMovementsSchema.creditoId, creditoIds))
    : [];

  // Creditos that exist because a transfer was resolved as a receivable — their
  // "opened" beat is already told by the transfer_to_credito event, so we don't
  // repeat it as a standalone "Pasó a credito".
  const creditoFromTransfer = new Set(
    transfers
      .map(t => t.resolutionCreditoId)
      .filter((id): id is string => id != null),
  );

  const events: SaleTimelineEvent[] = [];

  events.push({
    id: `sale-${sale.id}`,
    kind: 'sale_created',
    at: sale.createdAt.toISOString(),
    title: 'Venta creada',
    detail: sale.paymentType ? `Pago: ${sale.paymentType}` : null,
    amount: sale.total,
    tone: 'neutral',
  });

  for (const p of payments) {
    events.push({
      id: `pay-${p.id}`,
      kind: 'payment',
      at: p.createdAt.toISOString(),
      title: `Pago registrado — ${p.method}`,
      detail: null,
      amount: p.amount,
      tone: 'neutral',
    });
  }

  for (const t of transfers) {
    if (t.reconciledAt) {
      if (t.status === 'confirmed') {
        events.push({
          id: `tr-conf-${t.id}`,
          kind: 'transfer_confirmed',
          at: t.reconciledAt.toISOString(),
          title: 'Transferencia confirmada',
          detail: `Llegó completa por ${t.method}`,
          amount: t.arrivedAmount ?? t.expectedAmount,
          tone: 'success',
        });
      } else if (t.status === 'mismatch') {
        events.push({
          id: `tr-part-${t.id}`,
          kind: 'transfer_partial',
          at: t.reconciledAt.toISOString(),
          title: 'La transferencia llegó parcial',
          detail: `Esperado ${money(t.expectedAmount)} · llegó ${money(t.arrivedAmount ?? '0')}`,
          amount: t.arrivedAmount,
          tone: 'warning',
        });
      } else if (t.status === 'not_arrived') {
        events.push({
          id: `tr-na-${t.id}`,
          kind: 'transfer_not_arrived',
          at: t.reconciledAt.toISOString(),
          title: 'La transferencia no llegó',
          detail: `Se esperaban ${money(t.expectedAmount)}`,
          amount: null,
          tone: 'danger',
        });
      }
    } else if (t.status === 'pending') {
      events.push({
        id: `tr-pend-${t.id}`,
        kind: 'transfer_pending',
        at: t.createdAt.toISOString(),
        title: 'Transferencia por confirmar',
        detail: 'Pendiente de verificar contra el banco',
        amount: t.expectedAmount,
        tone: 'warning',
      });
    }

    if (t.cashierExplainedAt) {
      events.push({
        id: `tr-exp-${t.id}`,
        kind: 'cashier_explained',
        at: t.cashierExplainedAt.toISOString(),
        title: 'El cajero explicó la confirmación',
        detail: t.cashierExplanation ?? null,
        amount: null,
        tone: 'neutral',
      });
    }

    if (t.resolvedAt && t.resolutionType === 'receivable') {
      events.push({
        id: `tr-credito-${t.id}`,
        kind: 'transfer_to_credito',
        at: t.resolvedAt.toISOString(),
        title: 'Transferencia convertida en crédito',
        detail: 'El cliente queda debiendo el monto',
        amount: t.expectedAmount,
        tone: 'warning',
      });
    } else if (t.resolvedAt && t.resolutionType === 'loss') {
      events.push({
        id: `tr-loss-${t.id}`,
        kind: 'transfer_loss',
        at: t.resolvedAt.toISOString(),
        title: 'Transferencia dada como pérdida',
        detail: 'Se descontó de los ingresos',
        amount: t.expectedAmount,
        tone: 'danger',
      });
    }
  }

  for (const f of creditos) {
    if (!creditoFromTransfer.has(f.id)) {
      events.push({
        id: `credito-${f.id}`,
        kind: 'credito_opened',
        at: f.createdAt.toISOString(),
        title: 'Pasó a crédito',
        detail: `Vence el ${f.dueDate}`,
        amount: f.originalAmount,
        tone: 'warning',
      });
    }
  }

  // The latest payment movement per credito, so the "pagado totalmente" beat lands
  // at the moment the balance actually reached zero.
  const lastPaymentByCredito = new Map<string, Date>();
  for (const m of movements) {
    if (m.type === 'payment') {
      const prev = lastPaymentByCredito.get(m.creditoId);
      if (!prev || m.createdAt > prev) {
        lastPaymentByCredito.set(m.creditoId, m.createdAt);
      }
    }
  }

  for (const m of movements) {
    if (m.type === 'payment') {
      events.push({
        id: `fm-pay-${m.id}`,
        kind: 'credito_abono',
        at: m.createdAt.toISOString(),
        title: `Abono al crédito — ${m.method ?? 'efectivo'}`,
        detail: null,
        amount: m.amount,
        tone: 'success',
      });
    } else if (m.type === 'extension') {
      events.push({
        id: `fm-ext-${m.id}`,
        kind: 'credito_extended',
        at: m.createdAt.toISOString(),
        title: 'Plazo del crédito extendido',
        detail:
          m.dueDateBefore && m.dueDateAfter
            ? `${m.dueDateBefore} → ${m.dueDateAfter}`
            : null,
        amount: null,
        tone: 'neutral',
      });
    } else if (m.type === 'writeoff') {
      events.push({
        id: `fm-wo-${m.id}`,
        kind: 'credito_writeoff',
        at: m.createdAt.toISOString(),
        title: 'Crédito dado de baja',
        detail: null,
        amount: m.amount,
        tone: 'danger',
      });
    }
  }

  for (const f of creditos) {
    if (f.status === 'paid') {
      const at = lastPaymentByCredito.get(f.id) ?? f.createdAt;
      events.push({
        id: `credito-paid-${f.id}`,
        kind: 'credito_paid',
        at: at.toISOString(),
        title: 'Crédito pagado totalmente',
        detail: 'El cliente quedó al día',
        amount: null,
        tone: 'eco',
      });
    }
  }

  for (const r of returns) {
    events.push({
      id: `ret-${r.id}`,
      kind: 'return',
      at: r.createdAt.toISOString(),
      title: r.partial ? 'Devolución parcial' : 'Devolución total',
      detail: `Reembolso en ${r.refundMethod}`,
      amount: r.totalRefunded,
      tone: 'danger',
    });
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}
