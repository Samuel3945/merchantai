import { and, desc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { applyInvoiceCustomerUpsert } from '@/features/customers/post-sale-hook';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { findOpenSession, recordCashMovement, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { resolvePosAuth } from '@/libs/pos-auth';
import { assignNextSaleNumber } from '@/libs/sale-number';
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
};

export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
  );
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
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
    const openSession = await findOpenSession(db, ctx.organizationId);
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
        if (product.stock < qty) {
          throw new Error(
            `Stock insuficiente: ${product.name} (disp: ${product.stock})`,
          );
        }

        const unitPrice = Number.parseFloat(product.price);
        if (!Number.isFinite(unitPrice)) {
          throw new TypeError(`Precio inválido para producto ${product.id}`);
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

      return { ...sale, items: insertedItems, payments: insertedPayments };
    });

    await recordCashMovement(result.id, result.total, {
      organizationId: ctx.organizationId,
      userId: ctx.cashierId ?? ctx.cashierName,
    }).catch(() => null);

    await applyInvoiceCustomerUpsert({
      organizationId: ctx.organizationId,
      notes: result.notes,
      total: result.total,
      createdBy: ctx.cashierId ?? ctx.cashierName ?? null,
    }).catch(() => null);

    const forwarded = req.headers.get('x-forwarded-for');
    const ip
      = forwarded?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null;

    await logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
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
        paymentType,
        cashierName: ctx.cashierName,
        source: ctx.source,
        payments: result.payments.map(p => ({
          method: p.method,
          amount: p.amount,
        })),
      },
      ip,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al registrar venta' },
      { status: 400 },
    );
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
  );
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
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
  const cashierId = url.searchParams.get('cashierId')?.trim() || null;

  const conds = [eq(salesSchema.organizationId, ctx.organizationId)];
  if (cashierId) {
    conds.push(eq(salesSchema.cashierId, cashierId));
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
