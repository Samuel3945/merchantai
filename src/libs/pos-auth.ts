import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { posTokensSchema, posUsersSchema } from '@/models/Schema';

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PosAuthContext = {
  organizationId: string;
  cashierId: string | null;
  cashierName: string;
  canConfirmTransfers: boolean;
  source: 'token' | 'user';
};

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(authHeader);
  return match?.[1]?.trim() || null;
}

async function resolveFromToken(jwt: string): Promise<PosAuthContext | null> {
  const [row] = await db
    .select({
      token: posTokensSchema,
      cashierName: posUsersSchema.name,
      canConfirmTransfers: posUsersSchema.canConfirmTransfers,
    })
    .from(posTokensSchema)
    .leftJoin(posUsersSchema, eq(posUsersSchema.id, posTokensSchema.cashierId))
    .where(
      and(eq(posTokensSchema.token, jwt), eq(posTokensSchema.active, true)),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return {
    organizationId: row.token.organizationId,
    cashierId: row.token.cashierId,
    cashierName: row.cashierName || row.token.deviceName,
    canConfirmTransfers: row.canConfirmTransfers ?? true,
    source: 'token',
  };
}

async function resolveFromUser(jwt: string): Promise<PosAuthContext | null> {
  const [user] = await db
    .select()
    .from(posUsersSchema)
    .where(and(eq(posUsersSchema.id, jwt), eq(posUsersSchema.active, true)))
    .limit(1);

  if (!user) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    cashierId: user.id,
    cashierName: user.name,
    canConfirmTransfers: user.canConfirmTransfers,
    source: 'user',
  };
}

/**
 * Resuelve la auth del POS a partir del Bearer (token de caja o id de cajero).
 *
 * `activeCashierId` (header `X-Pos-Cashier-Id`): el empleado seleccionado en la
 * caja compartida. Si pertenece a la misma org del token y está activo, se usa
 * para atribuir la operación (venta/movimiento) a ese empleado en vez de al
 * cajero por defecto del token. Si no es válido, se ignora (cae al default).
 */
export async function resolvePosAuth(
  authHeader: string | null,
  activeCashierId?: string | null,
): Promise<PosAuthContext | null> {
  const jwt = extractBearer(authHeader);
  if (!jwt || !UUID_RE.test(jwt)) {
    return null;
  }
  const ctx = (await resolveFromToken(jwt)) ?? (await resolveFromUser(jwt));
  if (!ctx) {
    return null;
  }

  const override = activeCashierId?.trim();
  if (override && UUID_RE.test(override)) {
    const [emp] = await db
      .select({
        id: posUsersSchema.id,
        name: posUsersSchema.name,
        canConfirmTransfers: posUsersSchema.canConfirmTransfers,
      })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.id, override),
          eq(posUsersSchema.organizationId, ctx.organizationId),
          eq(posUsersSchema.active, true),
        ),
      )
      .limit(1);
    if (emp) {
      ctx.cashierId = emp.id;
      ctx.cashierName = emp.name;
      ctx.canConfirmTransfers = emp.canConfirmTransfers;
    }
  }

  return ctx;
}
