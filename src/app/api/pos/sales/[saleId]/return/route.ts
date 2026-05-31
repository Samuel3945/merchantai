import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import {
  cashMovementsSchema,
  posReturnItemsSchema,
  posReturnsSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_REASONS = [
  'wrong_product',
  'damaged',
  'customer_request',
  'price_error',
  'duplicate',
  'other',
] as const;

type ReturnReason = (typeof VALID_REASONS)[number];

type ReturnItemInput = {
  saleItemId?: string;
  qty?: number;
  refundAmount?: number | string;
  restock?: boolean;
};

type ReturnBody = {
  reason?: string;
  refundMethod?: string;
  items?: ReturnItemInput[];
  notes?: string | null;
  partial?: boolean;
};

const CASH_METHODS = new Set(['efectivo', 'cash']);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ saleId: string }> },
): Promise<NextResponse> {
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

  const { saleId } = await params;
  if (!saleId) {
    return NextResponse.json({ error: 'saleId es requerido' }, { status: 400 });
  }

  let body: ReturnBody;
  try {
    body = (await req.json()) as ReturnBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const reason = body.reason as ReturnReason | undefined;
  const refundMethod = body.refundMethod?.trim();
  const items = body.items ?? [];
  const partial = !!body.partial;

  if (!reason || !VALID_REASONS.includes(reason)) {
    return NextResponse.json({ error: 'reason inválido' }, { status: 400 });
  }
  if (!refundMethod) {
    return NextResponse.json(
      { error: 'refundMethod es requerido' },
      { status: 400 },
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: 'items es requerido' },
      { status: 400 },
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [sale] = await tx
        .select({ id: salesSchema.id, status: salesSchema.status })
        .from(salesSchema)
        .where(
          and(
            eq(salesSchema.id, saleId),
            eq(salesSchema.organizationId, ctx.organizationId),
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
        .where(eq(saleItemsSchema.saleId, saleId));

      const saleItemById = new Map(saleItemRows.map(r => [r.id, r]));

      type Resolved = {
        saleItemId: string;
        productId: string;
        productName: string;
        qty: number;
        refundAmount: string;
        restock: boolean;
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

        totalRefund += amountNum;
        resolved.push({
          saleItemId: orig.id,
          productId: orig.productId,
          productName: orig.productName,
          qty,
          refundAmount: toMoney(amountNum),
          restock: it.restock !== false,
        });
      }

      const totalRefundStr = toMoney(totalRefund);

      const [returnRow] = await tx
        .insert(posReturnsSchema)
        .values({
          organizationId: ctx.organizationId,
          saleId,
          reason,
          notes: body.notes ?? null,
          totalRefunded: totalRefundStr,
          refundMethod,
          partial,
          cashierId: ctx.cashierId,
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
          })),
        )
        .returning();

      for (const r of resolved) {
        if (!r.restock) {
          continue;
        }
        await tx
          .update(productsSchema)
          .set({ stock: sql`${productsSchema.stock} + ${r.qty}` })
          .where(
            and(
              eq(productsSchema.id, r.productId),
              eq(productsSchema.organizationId, ctx.organizationId),
            ),
          );
        await tx.execute(
          sql`INSERT INTO stock_movements (product_id, product_name, type, qty, reason, created_by)
              VALUES (${r.productId}, ${r.productName}, 'entry', ${r.qty}, 'return_sale', ${ctx.cashierName})`,
        );
      }

      if (!partial) {
        await tx
          .update(salesSchema)
          .set({ status: 'returned' })
          .where(eq(salesSchema.id, saleId));
      }

      if (
        CASH_METHODS.has(refundMethod.toLowerCase())
        && totalRefund > 0
      ) {
        const open = await findOpenSession(tx, ctx.organizationId);
        if (open) {
          await tx.insert(cashMovementsSchema).values({
            sessionId: open.id,
            organizationId: ctx.organizationId,
            type: 'adjustment',
            amount: toMoney(-totalRefund),
            reason: `Devolución venta #${saleId.slice(0, 6).toUpperCase()}${partial ? ' (parcial)' : ''}`,
            createdBy: ctx.cashierName,
            authorizedBy: ctx.cashierName,
            saleId,
          });
        }
      }

      return {
        id: returnRow.id,
        totalRefunded: totalRefundStr,
        items: insertedItems,
        partial,
      };
    });

    const forwarded = req.headers.get('x-forwarded-for');
    const ip
      = forwarded?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null;

    await logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
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
        reason,
        refundMethod,
        partial: result.partial,
        cashierName: ctx.cashierName,
        source: ctx.source,
      },
      ip,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al procesar devolución',
      },
      { status: 400 },
    );
  }
}
