import { NextResponse } from 'next/server';
import { getFiadosHistory } from '@/libs/fiados';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app fiados history. Returns the most recently settled client groups
// (status = 'paid'), newest-settled first, limit 100. Uses the same
// getFiadosHistory query as the dashboard Historial tab — single source of truth.
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  const history = await getFiadosHistory(ctx.organizationId);
  // Limit to 100 most recent entries so the POS list stays snappy.
  return NextResponse.json(history.slice(0, 100));
}
