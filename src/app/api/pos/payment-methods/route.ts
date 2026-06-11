import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Returns the active payment methods for the POS cashier app.
// Uses the same listActivePaymentMethods logic as /api/pos/me so the cashier
// can fetch payment methods independently without loading the full /me payload.
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  try {
    const result = await db.execute(
      sql`SELECT id, name, type, icon, active, sort_order, details, description,
                 start_hour, end_hour
          FROM payment_methods
          WHERE organization_id = ${ctx.organizationId} AND active = true
          ORDER BY sort_order`,
    );
    return NextResponse.json(result.rows);
  } catch {
    return NextResponse.json(
      { error: 'Error al obtener métodos de pago' },
      { status: 500 },
    );
  }
}
