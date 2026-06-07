import { NextResponse } from 'next/server';
import {
  normalizeClientKey,
  recordAbono,
  saleIdsForFiados,
} from '@/libs/fiados';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AbonarBody = {
  clientKey?: string;
  amount?: number | string;
  method?: string;
  notes?: string | null;
};

// Cashier-app abono. Delegates to the shared ledger core so an abono made at the
// register is identical to one made on the dashboard, and a cash abono lands in
// Caja as a "Cobro de fiado". Keeps the legacy { applied, remaining,
// settledSaleIds } response shape (plus hitCaja).
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

  let body: AbonarBody;
  try {
    body = (await req.json()) as AbonarBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.clientKey) {
    return NextResponse.json({ error: 'clientKey es requerido' }, { status: 400 });
  }

  try {
    const result = await recordAbono({
      organizationId: ctx.organizationId,
      clientKey: normalizeClientKey(body.clientKey),
      amount: body.amount ?? 0,
      method: body.method ?? '',
      note: body.notes ?? null,
      createdBy: ctx.cashierId ?? ctx.cashierName ?? 'pos',
    });
    const settledSaleIds = await saleIdsForFiados(result.paidFiadoIds);
    return NextResponse.json({
      applied: result.applied,
      remaining: result.remaining,
      settledSaleIds,
      hitCaja: result.hitCaja,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al registrar abono' },
      { status: 400 },
    );
  }
}
