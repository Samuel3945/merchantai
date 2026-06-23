import type { SQL } from 'drizzle-orm';
import type { PosAuthContext } from '@/libs/pos-auth';
import { and, desc, eq, gte, ilike, lt, lte, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { resolvePosActor } from '@/libs/audit-log';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { createFiado } from '@/libs/fiados';
import { fiadoAmountFor } from '@/libs/fiados-math';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { requirePosAuth } from '@/libs/pos-auth';
import { salePaymentsAggJson } from '@/libs/pos-sales-payments-agg';
import { applyPostSaleSideEffects } from '@/libs/post-sale-side-effects';
import { assignNextSaleNumber } from '@/libs/sale-number';
import { resolveOccurredAt } from '@/libs/sale-occurred-at';
import { normalizeIdempotencyKey } from '@/libs/uuid';
import { wholesaleUnitPrice } from '@/libs/wholesale';
import {
  productsSchema,
  saleItemsSchema,
  salePaymentsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SalePaymentInput = {
  method: string;
  amount: number | string;
  reference?: string | null;
  billsPaid?: unknown;
  changeGiven?: number | string;
};

type CreateSaleBody = {
  items?: { productId: string; qty: number }[];
  paymentType?: string;
  notes?: string | null;
  payments?: SalePaymentInput[];
  // Optional manual due date ('YYYY-MM-DD') for fiado sales; org default term
  // applies when omitted.
  dueDate?: string | null;
  // Optional real sale time (ISO) for offline-capable clients. Omitted by the
  // always-online web POS, in which case the server stamps the current time.
  occurredAt?: string | null;
  // Device-generated UUID v4 for exactly-once mobile sync. Absent for the web
  // POS and pos-merchatai (back-compat: treated as null, no dedupe check).
  sale_idempotency_key?: string | null;
};

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  return (
    forwarded?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || null
  );
}

type SaleRow = typeof salesSchema.$inferSelect;

// Re-loads a sale's items + payments so a deduped response matches the create
// response shape ({ ...sale, items, payments }) instead of returning a bare row.
async function loadSaleItemsAndPayments(saleId: string): Promise<{
  items: (typeof saleItemsSchema.$inferSelect)[];
  payments: (typeof salePaymentsSchema.$inferSelect)[];
}> {
  const [items, payments] = await Promise.all([
    db.select().from(saleItemsSchema).where(eq(saleItemsSchema.saleId, saleId)),
    db
      .select()
      .from(salePaymentsSchema)
      .where(eq(salePaymentsSchema.saleId, saleId)),
  ]);
  return { items, payments };
}

// Builds the 200 deduped response for an already-existing sale. Crucially it
// first runs applyPostSaleSideEffects: if the original request died between the
// sale commit and recordCashMovement, this retry completes the missing cash
// movement (and any other unfinished side effect) — converging on exactly one
// cash_movement / one set of side effects per sale_id without touching stock.
async function dedupedResponse(
  sale: SaleRow,
  ctx: PosAuthContext,
  req: Request,
): Promise<NextResponse> {
  await applyPostSaleSideEffects({
    organizationId: ctx.organizationId,
    saleId: sale.id,
    total: sale.total,
    notes: sale.notes,
    userId: ctx.cashierId ?? ctx.cashierName,
    createdBy: ctx.cashierId ?? ctx.cashierName ?? null,
    posTokenId: ctx.tokenId,
    audit: {
      actor: resolvePosActor(ctx),
      action: 'sale.created',
      after: {
        id: sale.id,
        total: sale.total,
        paymentType: sale.paymentType,
        status: sale.status,
      },
      metadata: {
        paymentType: sale.paymentType,
        cashierName: ctx.cashierName,
        source: ctx.source,
        deduped: true,
      },
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    },
  });

  const { items, payments } = await loadSaleItemsAndPayments(sale.id);
  return NextResponse.json(
    { ...sale, items, payments, deduped: true },
    { status: 200 },
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: CreateSaleBody;
  try {
    body = (await req.json()) as CreateSaleBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const items = body.items ?? [];
  if (items.length === 0) {
    return NextResponse.json(
      { error: 'La venta debe incluir al menos un producto' },
      { status: 400 },
    );
  }

  const paymentType = body.paymentType?.trim() || 'Efectivo';
  // Real business time of the sale (clamped). Web POS omits it → stamps now().
  const occurredAt = resolveOccurredAt(body.occurredAt, new Date());

  // Regla portada de Tiendademo (pos.service.webSale): una venta que mueve
  // efectivo exige una caja abierta. Los pagos 100% fiado no afectan la caja,
  // así que se permiten sin sesión abierta.
  const paymentMethods
    = body.payments && body.payments.length > 0
      ? body.payments.map(p => p.method ?? '')
      : [paymentType];
  const requiresOpenCash = !paymentMethods.every(m =>
    m.toLowerCase().includes('fiado'),
  );
  if (requiresOpenCash) {
    const openSession = await findOpenSession(db, ctx.organizationId, ctx.tokenId);
    if (!openSession) {
      return NextResponse.json(
        {
          error:
            'La caja está cerrada. Abre la caja antes de registrar ventas.',
        },
        { status: 400 },
      );
    }
  }

  // Exactly-once dedupe: if the client sent a sale_idempotency_key, check
  // whether we already have a row for it. This is the BELT of the
  // belt-and-suspenders strategy; the SUSPENDERS are the partial UNIQUE index
  // + 23505 catch inside the transaction (see below).
  // Correctness without the index: this pre-SELECT covers the common case. It
  // only misses a tight concurrent-retry race (two requests arrive at the same
  // ms before either commits); the 23505 catch resolves that race.
  // A present-but-malformed (non-UUID) key would hit the `uuid` column at the
  // pre-SELECT and throw Postgres 22P02 (→ 500). Normalize it to null instead:
  // no dedupe, normal create (back-compat with clients that send garbage).
  const idempotencyKey = normalizeIdempotencyKey(body.sale_idempotency_key);
  if (idempotencyKey) {
    const [existing] = await db
      .select()
      .from(salesSchema)
      .where(
        and(
          eq(salesSchema.organizationId, ctx.organizationId),
          eq(salesSchema.saleIdempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      return dedupedResponse(existing, ctx, req);
    }
  }

  try {
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
      // products.cost per line, aligned by index, for FIFO fallback valuation.
      const lineFallbackCost: string[] = [];
      // Digital products skip the stock decrement; availability is governed by
      // the optional digitalLimit counter (NULL = unlimited).
      const digitalById = new Map<string, { digitalLimit: number | null }>();

      for (const item of items) {
        if (!item.productId) {
          throw new Error('Cada item debe incluir productId');
        }
        const qty = Number(item.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error('Cada item debe tener qty > 0');
        }

        const [product] = await tx
          .select()
          .from(productsSchema)
          .where(
            and(
              eq(productsSchema.id, item.productId),
              eq(productsSchema.organizationId, ctx.organizationId),
              eq(productsSchema.deleted, false),
            ),
          )
          .for('update')
          .limit(1);

        if (!product) {
          throw new Error(`Producto no encontrado: ${item.productId}`);
        }
        // Only published products are sellable; archived/draft are out of sale.
        if (product.status !== 'published') {
          throw new Error(`"${product.name}" no está disponible para la venta`);
        }
        if (product.isDigital) {
          digitalById.set(product.id, { digitalLimit: product.digitalLimit });
          if (product.digitalLimit !== null && product.digitalLimit < qty) {
            throw new Error(
              `Límite de ventas alcanzado: ${product.name} (disp: ${product.digitalLimit})`,
            );
          }
        } else if (!ctx.allowOversell && product.stock < qty) {
          // This caja enforces stock; cajas with allow_oversell let it through.
          throw new Error(
            `Stock insuficiente: ${product.name} (disp: ${product.stock})`,
          );
        }

        const basePrice = Number.parseFloat(product.price);
        if (!Number.isFinite(basePrice)) {
          throw new TypeError(`Precio inválido para producto ${product.id}`);
        }
        // Wholesale: qty-based tier pricing, same rule the POS shows in the cart.
        const unitPrice = wholesaleUnitPrice(
          basePrice,
          product.isWholesale,
          product.wholesaleTiers,
          qty,
        );
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

      const saleNumber = await assignNextSaleNumber(tx, ctx.organizationId);

      const [sale] = await tx
        .insert(salesSchema)
        .values({
          organizationId: ctx.organizationId,
          saleNumber,
          total: totalStr,
          paymentType,
          status: 'completed',
          notes: body.notes ?? null,
          cashierId: ctx.cashierId,
          posTokenId: ctx.source === 'token' ? ctx.tokenId : null,
          occurredAt,
          saleIdempotencyKey: idempotencyKey ?? undefined,
        })
        .returning();

      if (!sale) {
        throw new Error('No se pudo crear la venta');
      }

      const insertedItems = await tx
        .insert(saleItemsSchema)
        .values(itemsToInsert.map(it => ({ saleId: sale.id, ...it })))
        .returning();

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
                  eq(productsSchema.organizationId, ctx.organizationId),
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
              eq(productsSchema.organizationId, ctx.organizationId),
            ),
          );
      }

      // FIFO consumption + exit cost capture, shared with the createSale action
      // so cashier sales feed COGS/margin exactly the same way.
      const exitRows = await consumeFifoExits(
        tx,
        ctx.organizationId,
        ctx.cashierId ?? null,
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
        = body.payments && body.payments.length > 0
          ? body.payments.map(p => ({
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
                method: paymentType,
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

      // Fiado: book the credit account for the portion not paid upfront with a
      // non-fiado method. Same rule as the dashboard createSale action.
      const fiadoAmount = fiadoAmountFor(total, paymentRows);
      const isFiado
        = /fiado/i.test(paymentType)
          || paymentRows.some(p => /fiado/i.test(p.method));
      if (isFiado && fiadoAmount > 0) {
        await createFiado(tx, {
          organizationId: ctx.organizationId,
          saleId: sale.id,
          originalAmount: fiadoAmount,
          dueDate: body.dueDate ?? null,
          createdBy: ctx.cashierId ?? ctx.cashierName ?? null,
          notes: body.notes ?? null,
        });
      }

      return { ...sale, items: insertedItems, payments: insertedPayments };
    });

    // Post-commit side effects, idempotent by sale_id and shared with the
    // deduped path (see applyPostSaleSideEffects). A retry that finds the sale
    // already created still runs this routine to complete anything the original
    // request never finished.
    await applyPostSaleSideEffects({
      organizationId: ctx.organizationId,
      saleId: result.id,
      total: result.total,
      notes: result.notes,
      userId: ctx.cashierId ?? ctx.cashierName,
      createdBy: ctx.cashierId ?? ctx.cashierName ?? null,
      posTokenId: ctx.tokenId,
      audit: {
        actor: resolvePosActor(ctx),
        action: 'sale.created',
        after: {
          id: result.id,
          total: result.total,
          paymentType: result.paymentType,
          status: result.status,
          itemCount: result.items.length,
        },
        metadata: {
          paymentType,
          cashierName: ctx.cashierName,
          source: ctx.source,
          payments: result.payments.map(p => ({
            method: p.method,
            amount: p.amount,
          })),
        },
        ip: clientIp(req),
        userAgent: req.headers.get('user-agent'),
      },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Suspenders: concurrent-retry race resolved via unique-constraint violation.
    // Two retries arriving at the same moment both pass the pre-SELECT (no row
    // yet), one commits, the other hits the partial UNIQUE index → 23505. We
    // re-SELECT the winner and return it as deduped (200). No stock is double-
    // decremented because the losing transaction was rolled back by Postgres.
    if (
      idempotencyKey
      && err !== null
      && typeof err === 'object'
      && 'code' in err
      && (err as { code: string }).code === '23505'
    ) {
      const [deduped] = await db
        .select()
        .from(salesSchema)
        .where(
          and(
            eq(salesSchema.organizationId, ctx.organizationId),
            eq(salesSchema.saleIdempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (deduped) {
        return dedupedResponse(deduped, ctx, req);
      }
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al registrar venta' },
      { status: 400 },
    );
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 1),
    200,
  );
  const offset = Math.max(
    Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0,
    0,
  );
  // Accept both spellings for backwards compatibility with deployed POS versions.
  const cashierId
    = (url.searchParams.get('cashierId') ?? url.searchParams.get('cashier_id'))?.trim() || null;
  const start = url.searchParams.get('start')?.trim() || null;
  const end = url.searchParams.get('end')?.trim() || null;
  const search = url.searchParams.get('search')?.trim() || null;
  const paymentType = url.searchParams.get('payment_type')?.trim() || null;

  const conds: SQL[] = [eq(salesSchema.organizationId, ctx.organizationId)];
  if (cashierId) {
    conds.push(eq(salesSchema.cashierId, cashierId));
  }
  if (start) {
    // Date-only params (YYYY-MM-DD) are parsed as Bogota midnight (UTC-5, no DST).
    // All other strings keep their existing behavior plus the NaN guard.
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(start)
      ? new Date(`${start}T00:00:00-05:00`)
      : new Date(start);
    if (!Number.isNaN(startDate.getTime())) {
      conds.push(gte(salesSchema.createdAt, startDate));
    }
  }
  if (end) {
    const endIsDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(end);
    const endDate = endIsDateOnly ? new Date(`${end}T00:00:00-05:00`) : new Date(end);
    if (!Number.isNaN(endDate.getTime())) {
      if (endIsDateOnly) {
        // Inclusive day filter: advance to the next Bogota day and bound exclusively.
        endDate.setDate(endDate.getDate() + 1);
        conds.push(lt(salesSchema.createdAt, endDate));
      } else {
        conds.push(lte(salesSchema.createdAt, endDate));
      }
    }
  }
  if (search) {
    const pattern = `%${search}%`;
    conds.push(
      or(
        ilike(salesSchema.notes, pattern),
        sql`${salesSchema.saleNumber}::text ILIKE ${pattern}`,
      )!,
    );
  }
  if (paymentType) {
    conds.push(eq(salesSchema.paymentType, paymentType));
  }
  // When the requester is a device token, scope to that register (own sales or legacy cashier match)
  if (ctx.source === 'token' && ctx.tokenId) {
    conds.push(
      or(
        eq(salesSchema.posTokenId, ctx.tokenId),
        and(sql`${salesSchema.posTokenId} IS NULL`, ctx.cashierId ? eq(salesSchema.cashierId, ctx.cashierId) : sql`false`),
      )!,
    );
  }
  const where = and(...conds);

  const [items, totalRow] = await Promise.all([
    db
      .select({
        id: salesSchema.id,
        total: salesSchema.total,
        paymentType: salesSchema.paymentType,
        status: salesSchema.status,
        notes: salesSchema.notes,
        cashierId: salesSchema.cashierId,
        createdAt: salesSchema.createdAt,
        items: sql<unknown>`COALESCE(
          json_agg(
            json_build_object(
              'id', ${saleItemsSchema.id},
              'productId', ${saleItemsSchema.productId},
              'productName', ${saleItemsSchema.productName},
              'qty', ${saleItemsSchema.qty},
              'price', ${saleItemsSchema.price},
              'subtotal', ${saleItemsSchema.subtotal},
              'unitType', COALESCE(${saleItemsSchema.unitType}, 'unit')
            )
          ) FILTER (WHERE ${saleItemsSchema.id} IS NOT NULL),
          '[]'
        )`,
        // Payment split (correlated subquery — see salePaymentsAggJson, which
        // avoids cartesian-multiplying the items aggregation above). The cashier
        // app reads it to correct a mis-entered "error de carga".
        payments: salePaymentsAggJson(),
      })
      .from(salesSchema)
      .leftJoin(saleItemsSchema, eq(saleItemsSchema.saleId, salesSchema.id))
      .where(where)
      .groupBy(salesSchema.id)
      .orderBy(desc(salesSchema.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(salesSchema)
      .where(where),
  ]);

  return NextResponse.json({
    items,
    total: totalRow[0]?.count ?? 0,
    limit,
    offset,
  });
}
