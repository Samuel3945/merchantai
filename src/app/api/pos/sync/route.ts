import { and, asc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { touchLastSync, validatePosToken } from '@/actions/pos-tokens';
import { applyInvoiceCustomerUpsert } from '@/features/customers/post-sale-hook';
import { recordCashMovement, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { createFiado } from '@/libs/fiados';
import { fiadoAmountFor } from '@/libs/fiados-math';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import { assignNextSaleNumber } from '@/libs/sale-number';
import { recordSaleTransferReconciliations } from '@/libs/transfer-reconciliation';
import {
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

  for (const queuedSale of queued) {
    // Exactly-once dedupe key — declared here so the catch block can reference
    // it for the 23505 re-SELECT suspenders path.
    const batchIdempotencyKey = queuedSale.sale_idempotency_key?.trim() || null;

    try {
      if (!queuedSale.items?.length) {
        throw new Error('Sale must include at least one item');
      }

      // Belt (pre-SELECT) before the insert transaction.
      if (batchIdempotencyKey) {
        const [existingSale] = await db
          .select({ id: salesSchema.id })
          .from(salesSchema)
          .where(
            and(
              eq(salesSchema.organizationId, orgId),
              eq(salesSchema.saleIdempotencyKey, batchIdempotencyKey),
            ),
          )
          .limit(1);
        if (existingSale) {
          results.push({
            localId: queuedSale.localId,
            success: true,
            serverSaleId: existingSale.id,
          });
          continue;
        }
      }

      const { saleId, total: saleTotal } = await db.transaction(async (tx) => {
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

        // Fiado: book the credit account for the unpaid (non-upfront) portion,
        // same rule as the online POS and dashboard paths.
        const fiadoAmount = fiadoAmountFor(total, paymentRows);
        const isFiado
          = /fiado/i.test(queuedSale.paymentType || '')
            || paymentRows.some(p => /fiado/i.test(p.method));
        if (isFiado && fiadoAmount > 0) {
          await createFiado(tx, {
            organizationId: orgId,
            saleId: sale.id,
            originalAmount: fiadoAmount,
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

      await recordCashMovement(saleId, saleTotal, {
        organizationId: orgId,
        userId: cashierId ?? deviceName,
        posTokenId: posToken.id,
      }).catch(() => null);

      await recordSaleTransferReconciliations(saleId).catch(() => null);

      await applyInvoiceCustomerUpsert({
        organizationId: orgId,
        notes: queuedSale.notes ?? null,
        total: saleTotal,
        createdBy: cashierId ?? deviceName ?? null,
      }).catch(() => null);
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
          .select({ id: salesSchema.id })
          .from(salesSchema)
          .where(
            and(
              eq(salesSchema.organizationId, orgId),
              eq(salesSchema.saleIdempotencyKey, batchIdempotencyKey),
            ),
          )
          .limit(1);
        if (deduped) {
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
