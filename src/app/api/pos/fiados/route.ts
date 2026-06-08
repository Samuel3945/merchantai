import { NextResponse } from 'next/server';
import { getFiadosForPos } from '@/libs/fiados';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app fiados list. Reads from the SAME fiados ledger as the dashboard
// (single source of truth) and maps it onto the legacy { stats, clients } shape
// the cashier UI already consumes — see getFiadosForPos.
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  const result = await getFiadosForPos(ctx.organizationId);
  return NextResponse.json(result);
}
