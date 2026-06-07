import { NextResponse } from 'next/server';
import {
  getClientPendingBalance,
  normalizeClientKey,
  recordAbono,
  saleIdsForFiados,
} from '@/libs/fiados';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SettleBody = {
  clientKey?: string;
  method?: string;
};

// Cashier-app "marcar como pagado": records an abono for the client's full
// remaining balance via the ledger (audited + Caja for efectivo), then every
// covered fiado flips to paid. Replaces the old lossy status-flip.
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

  let body: SettleBody;
  try {
    body = (await req.json()) as SettleBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.clientKey) {
    return NextResponse.json({ error: 'clientKey es requerido' }, { status: 400 });
  }

  const clientKey = normalizeClientKey(body.clientKey);
  const method = body.method?.trim() || 'efectivo';

  try {
    const balance = await getClientPendingBalance(ctx.organizationId, clientKey);
    if (balance <= 0) {
      return NextResponse.json({ settledSaleIds: [], settled: 0, totalPaid: 0 });
    }

    const result = await recordAbono({
      organizationId: ctx.organizationId,
      clientKey,
      amount: balance,
      method,
      note: 'Marcar como pagado',
      createdBy: ctx.cashierId ?? ctx.cashierName ?? 'pos',
    });
    const settledSaleIds = await saleIdsForFiados(result.paidFiadoIds);
    return NextResponse.json({
      settledSaleIds,
      settled: settledSaleIds.length,
      totalPaid: result.applied,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al saldar fiados' },
      { status: 400 },
    );
  }
}
