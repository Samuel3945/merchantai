import type { ReturnItemInput, ReturnReason } from '@/libs/sale-returns';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import {
  applySaleReturn,
  VALID_RETURN_REASONS,
} from '@/libs/sale-returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ReturnBody = {
  reason?: string;
  refundMethod?: string;
  items?: ReturnItemInput[];
  notes?: string | null;
  partial?: boolean;
};

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

  if (!reason || !VALID_RETURN_REASONS.includes(reason)) {
    return NextResponse.json({ error: 'reason inválido' }, { status: 400 });
  }
  if (!refundMethod) {
    return NextResponse.json(
      { error: 'refundMethod es requerido' },
      { status: 400 },
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items es requerido' }, { status: 400 });
  }

  try {
    const result = await db.transaction(tx =>
      applySaleReturn(tx, {
        saleId,
        organizationId: ctx.organizationId,
        cashierId: ctx.cashierId,
        actorName: ctx.cashierName,
        reason,
        refundMethod,
        items,
        notes: body.notes ?? null,
        partial: !!body.partial,
      }),
    );

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
