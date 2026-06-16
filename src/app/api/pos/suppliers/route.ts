import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { suppliersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

// Active suppliers for the cashier's org. The device picks one when registering a
// "Pago a proveedor" cash movement (POST /pos/cash/movement with supplierId).
// Read-only: the cashier never creates suppliers — that master-data stays with
// the owner in the dashboard. The list is small (<=200), so the device filters
// by search text client-side.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const suppliers = await db
    .select({
      id: suppliersSchema.id,
      name: suppliersSchema.name,
      company: suppliersSchema.company,
    })
    .from(suppliersSchema)
    .where(
      and(
        eq(suppliersSchema.organizationId, ctx.organizationId),
        eq(suppliersSchema.status, 'active'),
      ),
    )
    .orderBy(asc(suppliersSchema.name))
    .limit(LIST_LIMIT);

  return NextResponse.json({ suppliers });
}
