import { NextResponse } from 'next/server';
import { getCreditosHistoryForPos } from '@/libs/creditos';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app creditos history. Returns the most recently settled client groups
// (status = 'paid') org-wide — a debt settled at any register/sede shows here,
// newest-settled first, limit 100. Maps to the snake_case wire shape the device
// expects (getCreditosHistoryForPos), reading the same ledger as the dashboard.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const history = await getCreditosHistoryForPos(ctx.organizationId);
  // Limit to 100 most recent entries so the POS list stays snappy.
  return NextResponse.json(history.slice(0, 100));
}
