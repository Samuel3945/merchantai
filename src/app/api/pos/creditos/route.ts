import { NextResponse } from 'next/server';
import { getCreditosForPos } from '@/libs/creditos';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app creditos list. Reads from the SAME creditos ledger as the dashboard
// (single source of truth) and maps it onto the legacy { stats, clients } shape
// the cashier UI already consumes — see getCreditosForPos.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const result = await getCreditosForPos(ctx.organizationId);
  return NextResponse.json(result);
}
