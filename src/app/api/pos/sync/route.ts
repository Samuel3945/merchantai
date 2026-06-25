import { and, asc, eq, gt, ne, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { touchLastSync, validatePosToken } from '@/actions/pos-tokens';
import { toMoney } from '@/libs/cash-helpers';
import { createCredito } from '@/libs/creditos';
import { creditoAmountFor, isCreditoMethod } from '@/libs/creditos-math';
import { db } from '@/libs/DB';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { requirePosAuth } from '@/libs/pos-auth';
import { applyPostSaleSideEffects } from '@/libs/post-sale-side-effects';
import { assignNextSaleNumber } from '@/libs/sale-number';
import { normalizeIdempotencyKey } from '@/libs/uuid';
import { parseWholesaleTiers } from '@/libs/wholesale';
import {
  appSettingsSchema,
  categoriesSchema,
  customersSchema,
  paymentMethodsSchema,
  posUsersSchema,
  productsSchema,
  saleItemsSchema,
  salePaymentsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type QueuedSaleItem = {
  productId: string;
  qty: number;
  productName?: string;
  unitPrice?: number;
};

type QueuedSalePayment = {
  method: string;
  amount: number | string;
  billsPaid?: unknown;
  changeGiven?: number | string;
  reference?: string | null;
};

type QueuedSale = {
  localId: number;
  items: QueuedSaleItem[];
  paymentType: string;
  total?: number;
  notes?: string | null;
  payments?: QueuedSalePayment[];
  queuedAt?: string;
  // Device-generated UUID v4 for exactly-once mobile sync. Absent for the
  // legacy pos-merchatai client (back-compat: stored as null, no dedupe).
  sale_idempotency_key?: string | null;
};

type SyncBody = {
  token?: string;
  sales?: QueuedSale[];
  deviceName?: string;
};

type SyncResult = {
  localId: number;
  success: boolean;
  serverSaleId?: string;
  error?: string;
};

export async function POST(req: Request): Promise<NextResponse> {
  let body: SyncBody;
  try {
    body = (await req.json()) as SyncBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  let posToken;
  try {
    posToken = await validatePosToken(token);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid token' },
      { status: 401 },
    );
  }

  const orgId = posToken.organizationId;
  const cashierId = posToken.cashierId;
  const deviceName = body.deviceName?.trim() || 'pos';
  const queued = Array.isArray(body.sales) ? body.sales : [];

  const results: SyncResult[] = [];

  // Post-commit side effects for a synced sale, idempotent by sale_id and run by
  // BOTH the create path and the deduped paths (pre-SELECT belt + 23505 catch).
  // A retry that finds the sale already created still runs this so it completes
  // the session-agnostic effects the original never finished (customer spend,
  // transfer reconciliations, audit sentinel), never re-touching stock. Cash is
  // deduped but a MISSING movement is left for arqueo on convergence retries —
  // see applyPostSaleSideEffects (a sale carries no cash_session_id).
  const runSideEffects = (
    saleId: string,
    total: string | number,
    notes: string | null,
    isConvergenceRetry = false,
  ): Promise<void> =>
    applyPostSaleSideEffects({
      organizationId: orgId,
      saleId,
      total,
      notes,
      userId: cashierId ?? deviceName,
      createdBy: cashierId ?? deviceName ?? null,
      isConvergenceRetry,
      audit: {
        actor: { type: 'cashier', id: cashierId ?? `device:${deviceName}` },
        action: 'sale.created',
        after: { id: saleId, total },
        metadata: { source: 'sync', deviceName },
      },
    });

  for (const queuedSale of queued) {
    // Exactly-once dedupe key — declared here so the catch block can reference
    // it for the 23505 re-SELECT suspenders path. A present-but-malformed
    // (non-UUID) key would hit the `uuid` column and throw 22P02, permanently
    // rejecting this localId on every retry; normalize it to null instead (no
    // dedupe, normal create — back-compat with clients that send garbage).
    const batchIdempotencyKey = normalizeIdempotencyKey(
      queuedSale.sale_idempotency_key,
    );

    try {
      if (!queuedSale.items?.length) {
        throw new Error('Sale must include at least one item');
      }

      // Belt (pre-SELECT) before the insert transaction.
      if (batchIdempotencyKey) {
        const [existingSale] = await db
          .select({
            id: salesSchema.id,
            total: salesSchema.total,
            notes: salesSchema.notes,
          })
          .from(salesSchema)
          .where(
            and(
              eq(salesSchema.organizationId, orgId),
              eq(salesSchema.saleIdempotencyKey, batchIdempotencyKey),
            ),
          )
          .limit(1);
        if (existingSale) {
          // Deduped: complete the session-agnostic side effects the original
          // never finished. Idempotent by sale_id; a missing cash movement is
          // left for arqueo (convergence retry → do not book the wrong session).
          await runSideEffects(
            existingSale.id,
            existingSale.total,
            existingSale.notes,
            true,
          );
          results.push({
            localId: queuedSale.localId,
            success: true,
            serverSaleId: existingSale.id,
          });
          continue;
        }
      }

      const { saleId, total: saleTotal, notes: saleNotes } = await db.transaction(async (tx) => {
        let total = 0;
        const itemsToInsert: {
          productId: string;
          productName: string;
          qty: number;
          price: string;
          subtotal: string;
          unitType: string;
        }[] = [];
        // products.cost per line, aligned by index, for FIFO fallback valuation.
        const lineFallbackCost: string[] = [];
        // Digital products skip the stock decrement; availability is governed
        // by the optional digitalLimit counter (NULL = unlimited).
        const digitalById = new Map<string, { digitalLimit: number | null }>();

        for (const item of queuedSale.items) {
          if (!item.productId) {
            throw new Error('Each item must include a productId');
          }
          const qty = Number(item.qty);
          if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error('Each item must have qty > 0');
          }

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
            throw new Error(
              `Producto no encontrado: ${item.productName || item.productId}`,
            );
          }
          if (product.isDigital) {
            digitalById.set(product.id, { digitalLimit: product.digitalLimit });
            if (product.digitalLimit !== null && product.digitalLimit < qty) {
              throw new Error(
                `Límite de ventas alcanzado: ${product.name} (disp: ${product.digitalLimit})`,
              );
            }
          } else if (!posToken.allowOversell && product.stock < qty) {
            // This caja enforces stock; cajas with allow_oversell let it through.
            throw new Error(
              `Stock insuficiente: ${product.name} (disp: ${product.stock})`,
            );
          }

          const unitPrice = Number.parseFloat(product.price);
          if (!Number.isFinite(unitPrice)) {
            throw new TypeError(`Invalid price for product ${product.id}`);
          }
          const subtotal = unitPrice * qty;
          total += subtotal;

          itemsToInsert.push({
            productId: product.id,
            productName: product.name,
            qty,
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
            paymentType: queuedSale.paymentType || 'Efectivo',
            status: 'completed',
            notes: queuedSale.notes ?? null,
            cashierId,
            posTokenId: posToken.id,
            saleIdempotencyKey: batchIdempotencyKey ?? undefined,
          })
          .returning({ id: salesSchema.id });

        if (!sale) {
          throw new Error('Failed to create sale');
        }

        await tx
          .insert(saleItemsSchema)
          .values(itemsToInsert.map(it => ({ saleId: sale.id, ...it })));

        for (const it of itemsToInsert) {
          const digital = digitalById.get(it.productId);
          if (digital) {
            if (digital.digitalLimit !== null) {
              await tx
                .update(productsSchema)
                .set({
                  digitalLimit: sql`GREATEST(0, ${productsSchema.digitalLimit} - ${it.qty})`,
                })
                .where(
                  and(
                    eq(productsSchema.id, it.productId),
                    eq(productsSchema.organizationId, orgId),
                  ),
                );
            }
            continue;
          }
          await tx
            .update(productsSchema)
            .set({
              stock: sql`GREATEST(0, ${productsSchema.stock} - ${it.qty})`,
            })
            .where(
              and(
                eq(productsSchema.id, it.productId),
                eq(productsSchema.organizationId, orgId),
              ),
            );
        }

        // FIFO consumption + exit cost capture, shared with every sale path.
        // (The previous raw INSERT here left org_id, sale_id and unit_cost
        // unset, so synced sales never reached COGS/margin.)
        const exitRows = await consumeFifoExits(
          tx,
          orgId,
          deviceName,
          sale.id,
          itemsToInsert.map((it, i) => ({
            productId: it.productId,
            productName: it.productName,
            qty: it.qty,
            fallbackCost: lineFallbackCost[i] ?? '0',
          })),
        );
        await tx.insert(stockMovementsSchema).values(exitRows);

        const paymentRows
          = queuedSale.payments && queuedSale.payments.length > 0
            ? queuedSale.payments.map(p => ({
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
                  method: queuedSale.paymentType,
                  amount: totalStr,
                  reference: null,
                  billsPaid: null,
                  changeGiven: '0',
                },
              ];

        await tx.insert(salePaymentsSchema).values(paymentRows);

        // Credito: book the credit account for the unpaid (non-upfront) portion,
        // same rule as the online POS and dashboard paths.
        const creditoAmount = creditoAmountFor(total, paymentRows);
        const isCredito
          = isCreditoMethod(queuedSale.paymentType)
            || paymentRows.some(p => isCreditoMethod(p.method));
        if (isCredito && creditoAmount > 0) {
          await createCredito(tx, {
            organizationId: orgId,
            saleId: sale.id,
            originalAmount: creditoAmount,
            createdBy: cashierId ?? deviceName ?? null,
            notes: queuedSale.notes ?? null,
          });
        }

        return { saleId: sale.id, total: totalStr, notes: queuedSale.notes ?? null };
      });

      results.push({
        localId: queuedSale.localId,
        success: true,
        serverSaleId: saleId,
      });

      await runSideEffects(saleId, saleTotal, saleNotes);
    } catch (err) {
      // Suspenders: concurrent-retry race resolved via 23505 unique violation.
      // If two retries with the same key arrive concurrently, one commits and
      // the other hits the partial UNIQUE index. Re-SELECT and return success.
      if (
        batchIdempotencyKey
        && err !== null
        && typeof err === 'object'
        && 'code' in err
        && (err as { code: string }).code === '23505'
      ) {
        const [deduped] = await db
          .select({
            id: salesSchema.id,
            total: salesSchema.total,
            notes: salesSchema.notes,
          })
          .from(salesSchema)
          .where(
            and(
              eq(salesSchema.organizationId, orgId),
              eq(salesSchema.saleIdempotencyKey, batchIdempotencyKey),
            ),
          )
          .limit(1);
        if (deduped) {
          // Same convergence guarantee on the concurrent-retry race winner
          // (convergence retry → dedupe cash, never book the wrong session).
          await runSideEffects(deduped.id, deduped.total, deduped.notes, true);
          results.push({
            localId: queuedSale.localId,
            success: true,
            serverSaleId: deduped.id,
          });
          continue;
        }
      }
      results.push({
        localId: queuedSale.localId,
        success: false,
        error: err instanceof Error ? err.message : 'Error al sincronizar venta',
      });
    }
  }

  await touchLastSync(token).catch(() => null);

  const products = await db
    .select()
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .orderBy(asc(productsSchema.name));

  // Digital products report a virtual stock to the cashier: the remaining
  // sales limit, or an effectively-infinite count when unlimited — so the POS
  // cart caps work unchanged. The server-side checks above stay authoritative.
  const wireProducts = products.map(p => ({
    ...p,
    stock: p.isDigital ? (p.digitalLimit ?? 999999) : p.stock,
    is_digital: p.isDigital,
  }));

  return NextResponse.json({ results, products: wireProducts });
}

// ── GET /api/pos/sync?since=<ISO> — delta sync DOWN (REQ-03/REQ-09) ──────────
// Returns only the rows each read-model entity changed since the device's
// watermark, so an offline-first device pulls deltas instead of the whole
// catalog. The POST above stays the sync-UP (sale batch) path, untouched for the
// web POS.
//
// Shape: { server_time, has_more: {<entity>: bool},
//          <entity>: { updated: [...], deleted: ["id"] } }
// for products, payment_methods, customers, categories, app_settings, employees.
// Only products + customers carry tombstones (soft-deleted / non-published rows
// whose updated_at crossed the watermark) so the device removes them locally.
// Employee PIN hashes are NEVER here — they ride the dedicated
// /api/pos/employees/secrets path (REQ-09).
//
// Cursor: strict `updated_at > since`. A row exactly on the boundary is re-sent
// next pull and re-applied idempotently (the device upserts), so no row is
// skipped. First run (no `since`) returns the full catalog and empty deleted
// sets. `limit` (default 500, max 1000) caps each entity; `has_more[entity]`
// tells the device to pull again.
const SYNC_PAGE_DEFAULT = 500;
const SYNC_PAGE_MAX = 1000;

export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }
  const orgId = ctx.organizationId;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  let since: Date | null = null;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'invalid since (expected ISO timestamp)' },
        { status: 400 },
      );
    }
    since = parsed;
  }

  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), SYNC_PAGE_MAX)
    : SYNC_PAGE_DEFAULT;

  const isoOrNull = (d: Date | null | undefined): string | null =>
    d ? d.toISOString() : null;

  const [
    products,
    productTombstones,
    paymentMethods,
    customers,
    customerTombstones,
    categories,
    appSettings,
    employees,
  ] = await Promise.all([
    // products: published & not deleted that changed since the watermark.
    db
      .select()
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
          eq(productsSchema.status, 'published'),
          since ? gt(productsSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(productsSchema.updatedAt), asc(productsSchema.id))
      .limit(limit),
    // products tombstones: deleted OR no-longer-published (archived/draft/
    // scheduled). The complement of `updated`, so every changed product lands in
    // exactly one bucket. Empty on first run (the device has nothing to remove).
    since
      ? db
          .select({ id: productsSchema.id })
          .from(productsSchema)
          .where(
            and(
              eq(productsSchema.organizationId, orgId),
              gt(productsSchema.updatedAt, since),
              or(
                eq(productsSchema.deleted, true),
                ne(productsSchema.status, 'published'),
              ),
            ),
          )
          .orderBy(asc(productsSchema.updatedAt), asc(productsSchema.id))
          .limit(limit)
      : Promise.resolve([] as { id: string }[]),
    db
      .select()
      .from(paymentMethodsSchema)
      .where(
        and(
          eq(paymentMethodsSchema.organizationId, orgId),
          since ? gt(paymentMethodsSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(paymentMethodsSchema.updatedAt), asc(paymentMethodsSchema.id))
      .limit(limit),
    db
      .select()
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, orgId),
          eq(customersSchema.deleted, false),
          since ? gt(customersSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(customersSchema.updatedAt), asc(customersSchema.id))
      .limit(limit),
    since
      ? db
          .select({ id: customersSchema.id })
          .from(customersSchema)
          .where(
            and(
              eq(customersSchema.organizationId, orgId),
              gt(customersSchema.updatedAt, since),
              eq(customersSchema.deleted, true),
            ),
          )
          .orderBy(asc(customersSchema.updatedAt), asc(customersSchema.id))
          .limit(limit)
      : Promise.resolve([] as { id: string }[]),
    db
      .select()
      .from(categoriesSchema)
      .where(
        and(
          eq(categoriesSchema.organizationId, orgId),
          since ? gt(categoriesSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(categoriesSchema.updatedAt), asc(categoriesSchema.id))
      .limit(limit),
    db
      .select()
      .from(appSettingsSchema)
      .where(
        and(
          eq(appSettingsSchema.organizationId, orgId),
          since ? gt(appSettingsSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(appSettingsSchema.updatedAt), asc(appSettingsSchema.key))
      .limit(limit),
    // employees: explicit column list so the bcrypt PIN hash + password hash are
    // NEVER selected. The hash is delivered only via /api/pos/employees/secrets.
    db
      .select({
        id: posUsersSchema.id,
        name: posUsersSchema.name,
        role: posUsersSchema.role,
        active: posUsersSchema.active,
        enabledModules: posUsersSchema.enabledModules,
        permissions: posUsersSchema.permissions,
        canConfirmTransfers: posUsersSchema.canConfirmTransfers,
        updatedAt: posUsersSchema.updatedAt,
      })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.organizationId, orgId),
          since ? gt(posUsersSchema.updatedAt, since) : undefined,
        ),
      )
      .orderBy(asc(posUsersSchema.updatedAt), asc(posUsersSchema.id))
      .limit(limit),
  ]);

  return NextResponse.json({
    server_time: new Date().toISOString(),
    products: {
      updated: products.map(p => ({
        id: p.id,
        name: p.name,
        barcode: p.barcode,
        price: p.price,
        cost: p.cost,
        // Digital products report their remaining sales limit as virtual stock
        // (or effectively-infinite), mirroring /pos/me so cart caps work offline.
        stock: p.isDigital ? (p.digitalLimit ?? 999999) : p.stock,
        category: p.category,
        unit_type: p.unitType,
        attributes: p.attributes,
        is_wholesale: p.isWholesale,
        is_digital: p.isDigital,
        digital_limit: p.digitalLimit,
        wholesale_tiers: parseWholesaleTiers(p.wholesaleTiers).map(t => ({
          min_qty: t.minQty,
          price: t.price,
        })),
        status: p.status,
        updated_at: isoOrNull(p.updatedAt),
      })),
      deleted: productTombstones.map(p => p.id),
    },
    payment_methods: {
      updated: paymentMethods.map(pm => ({
        id: pm.id,
        name: pm.name,
        type: pm.type,
        icon: pm.icon,
        active: pm.active,
        sort_order: pm.sortOrder,
        details: pm.details,
        updated_at: isoOrNull(pm.updatedAt),
      })),
      deleted: [],
    },
    customers: {
      updated: customers.map(c => ({
        id: c.id,
        name: c.name,
        document_id: c.documentId,
        whatsapp: c.whatsapp,
        email: c.email,
        address: c.address,
        notes: c.notes,
        updated_at: isoOrNull(c.updatedAt),
      })),
      deleted: customerTombstones.map(c => c.id),
    },
    categories: {
      updated: categories.map(c => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        updated_at: isoOrNull(c.updatedAt),
      })),
      deleted: [],
    },
    app_settings: {
      updated: appSettings.map(s => ({
        key: s.key,
        value: s.value,
        updated_at: isoOrNull(s.updatedAt),
      })),
      deleted: [],
    },
    employees: {
      updated: employees.map(e => ({
        id: e.id,
        name: e.name,
        role: e.role,
        active: e.active,
        enabled_modules: e.enabledModules,
        permissions: e.permissions,
        can_confirm_transfers: e.canConfirmTransfers,
        updated_at: isoOrNull(e.updatedAt),
      })),
      deleted: [],
    },
    has_more: {
      products: products.length === limit,
      payment_methods: paymentMethods.length === limit,
      customers: customers.length === limit,
      categories: categories.length === limit,
      app_settings: appSettings.length === limit,
      employees: employees.length === limit,
    },
  });
}
