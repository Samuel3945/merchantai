import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
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

/** Returned when the client sends an X-Pos-Session-Epoch that is stale. */
export const SESSION_REVOKED = Symbol('session_revoked');
export type PosAuthResult = PosAuthContext | null | typeof SESSION_REVOKED;

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(authHeader);
  return match?.[1]?.trim() || null;
}

/**
 * Parse the X-Pos-Session-Epoch header value.
 * Returns null when the header is absent or not a valid integer (legacy clients
 * without the header must keep working — backward-compat rule).
 */
function parseClientEpoch(raw: string | null): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function resolveFromToken(
  jwt: string,
  clientEpoch: number | null,
): Promise<PosAuthContext | typeof SESSION_REVOKED | null> {
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

  // Single-active-device enforcement: if the client sends a known epoch that is
  // older than the stored one, this session was superseded by a newer login.
  // Requests without the header are treated as legacy clients and pass through.
  if (clientEpoch != null && row.token.sessionEpoch > clientEpoch) {
    return SESSION_REVOKED;
  }

  return {
    organizationId: row.token.organizationId,
    cashierId: row.token.cashierId,
    cashierName: row.cashierName || row.token.deviceName,
    canConfirmTransfers: row.canConfirmTransfers ?? true,
    source: 'token',
  };
}

async function resolveFromUser(
  jwt: string,
  clientEpoch: number | null,
): Promise<PosAuthContext | typeof SESSION_REVOKED | null> {
  const [user] = await db
    .select()
    .from(posUsersSchema)
    .where(and(eq(posUsersSchema.id, jwt), eq(posUsersSchema.active, true)))
    .limit(1);

  if (!user) {
    return null;
  }

  // Same single-active-device check for email/password login path.
  if (clientEpoch != null && user.sessionEpoch > clientEpoch) {
    return SESSION_REVOKED;
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
 *
 * `sessionEpochHeader` (header `X-Pos-Session-Epoch`): the epoch the client
 * received at login time. If the stored epoch is higher, returns SESSION_REVOKED
 * so the caller can respond with 401 + code `session_revoked`. Absent header →
 * legacy client, epoch check is skipped (backward compat).
 */
export async function resolvePosAuth(
  authHeader: string | null,
  activeCashierId?: string | null,
  sessionEpochHeader?: string | null,
): Promise<PosAuthResult> {
  const jwt = extractBearer(authHeader);
  if (!jwt || !UUID_RE.test(jwt)) {
    return null;
  }

  const clientEpoch = parseClientEpoch(sessionEpochHeader ?? null);

  const ctx
    = (await resolveFromToken(jwt, clientEpoch))
      ?? (await resolveFromUser(jwt, clientEpoch));

  if (!ctx || ctx === SESSION_REVOKED) {
    return ctx;
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

/**
 * Drop-in helper for route handlers. Resolves POS auth from a Request object,
 * automatically reading `Authorization`, `X-Pos-Cashier-Id`, and
 * `X-Pos-Session-Epoch` headers.
 *
 * Returns `{ ctx, errorResponse: null }` on success, or
 * `{ ctx: null, errorResponse: NextResponse }` on any failure so the caller can
 * do: `const { ctx, errorResponse } = await requirePosAuth(req); if (errorResponse) return errorResponse;`
 */
export async function requirePosAuth(
  req: Request,
): Promise<
  | { ctx: PosAuthContext; errorResponse: null }
  | { ctx: null; errorResponse: NextResponse }
> {
  const result = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
    req.headers.get('x-pos-session-epoch'),
  );

  if (result === SESSION_REVOKED) {
    return {
      ctx: null,
      errorResponse: NextResponse.json(
        { error: 'Sesión revocada', code: 'session_revoked' },
        { status: 401 },
      ),
    };
  }

  if (!result) {
    return {
      ctx: null,
      errorResponse: NextResponse.json(
        { error: 'Sesión inválida o expirada' },
        { status: 401 },
      ),
    };
  }

  return { ctx: result, errorResponse: null };
}
