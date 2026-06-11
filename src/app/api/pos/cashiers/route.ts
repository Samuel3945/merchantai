import { and, asc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lista los empleados (cajeros) activos de la org de la caja. El cajero los
// muestra en el selector tras entrar con el token. Nunca se expone el PIN; solo
// `hasPin` para saber si pedir el teclado de PIN al seleccionar.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const cashiers = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      role: posUsersSchema.role,
      hasPin: sql<boolean>`(${posUsersSchema.pin} <> '')`,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, ctx.organizationId),
        eq(posUsersSchema.active, true),
      ),
    )
    .orderBy(asc(posUsersSchema.name));

  return NextResponse.json({ cashiers });
}
