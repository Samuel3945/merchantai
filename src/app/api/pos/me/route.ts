import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { getDefaultTermDays } from '@/libs/fiados';
import { parseWholesaleTiers } from '@/libs/wholesale';
import {
  cashSessionsSchema,
  posTokensSchema,
  posUsersSchema,
  productsSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CashPayload = {
  id: string;
  displayCode: string;
  deviceName: string;
  cashierId: string | null;
  label: string;
  session: {
    id: string;
    openedAt: string;
    openedBy: string;
    openingAmount: string;
  } | null;
  // El cajero (pos-merchatai Pos.tsx) lee `cash.cashSessionId` para decidir si
  // la caja está abierta y habilitar el POS. Si falta, siempre ve "Caja cerrada"
  // aunque exista una sesión abierta.
  cashSessionId: string | null;
};

type ResolvedContext = {
  organizationId: string;
  cash: CashPayload;
  canConfirmTransfers: boolean;
  sessionEpoch: number;
};

async function getSetting(
  organizationId: string,
  key: string,
): Promise<string> {
  try {
    const result = await db.execute<{ value: string | null }>(
      sql`SELECT value FROM app_settings WHERE organization_id = ${organizationId} AND key = ${key} LIMIT 1`,
    );
    return result.rows[0]?.value ?? '';
  } catch {
    return '';
  }
}

async function listActivePaymentMethods(organizationId: string) {
  try {
    const result = await db.execute(
      sql`SELECT id, name, type, icon, active, sort_order, details, description
          FROM payment_methods
          WHERE organization_id = ${organizationId} AND active = true
          ORDER BY sort_order`,
    );
    return result.rows;
  } catch {
    return [];
  }
}

async function listCashiers(organizationId: string) {
  return db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      role: posUsersSchema.role,
      hasPin: sql<boolean>`(${posUsersSchema.pin} <> '')`,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, organizationId),
        eq(posUsersSchema.active, true),
      ),
    )
    .orderBy(asc(posUsersSchema.name));
}

async function getOpenSession(
  organizationId: string,
  posTokenId: string | null,
): Promise<CashPayload['session']> {
  const [row] = await db
    .select({
      id: cashSessionsSchema.id,
      openedAt: cashSessionsSchema.openedAt,
      openedBy: cashSessionsSchema.openedBy,
      openingAmount: cashSessionsSchema.openingAmount,
    })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, organizationId),
        eq(cashSessionsSchema.status, 'open'),
        // Scope to this device's own till so each caja sees only its session.
        posTokenId === null
          ? isNull(cashSessionsSchema.posTokenId)
          : eq(cashSessionsSchema.posTokenId, posTokenId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    openedAt: row.openedAt.toISOString(),
    openedBy: row.openedBy,
    openingAmount: row.openingAmount,
  };
}

async function resolveFromToken(jwt: string): Promise<ResolvedContext | null> {
  if (!UUID_RE.test(jwt)) {
    return null;
  }

  const [row] = await db
    .select({
      token: posTokensSchema,
      cashierName: posUsersSchema.name,
      cashierCanConfirmTransfers: posUsersSchema.canConfirmTransfers,
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

  const orgId = row.token.organizationId;
  const session = await getOpenSession(orgId, row.token.id);

  return {
    organizationId: orgId,
    canConfirmTransfers: row.cashierCanConfirmTransfers ?? true,
    sessionEpoch: row.token.sessionEpoch,
    cash: {
      id: row.token.id,
      displayCode: row.token.deviceName.slice(0, 12),
      deviceName: row.token.deviceName,
      cashierId: row.token.cashierId,
      label: row.cashierName || row.token.deviceName,
      session,
      cashSessionId: session?.id ?? null,
    },
  };
}

async function resolveFromUser(jwt: string): Promise<ResolvedContext | null> {
  if (!UUID_RE.test(jwt)) {
    return null;
  }

  const [user] = await db
    .select()
    .from(posUsersSchema)
    .where(
      and(eq(posUsersSchema.id, jwt), eq(posUsersSchema.active, true)),
    )
    .limit(1);

  if (!user) {
    return null;
  }

  const session = await getOpenSession(user.organizationId, null);

  return {
    organizationId: user.organizationId,
    canConfirmTransfers: user.canConfirmTransfers,
    sessionEpoch: user.sessionEpoch,
    cash: {
      id: user.id,
      displayCode: user.name.slice(0, 12),
      deviceName: user.name,
      cashierId: user.id,
      label: user.name,
      session,
      cashSessionId: session?.id ?? null,
    },
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S.*)$/i.exec(authHeader);
  const jwt = match?.[1]?.trim();

  if (!jwt) {
    return NextResponse.json(
      { error: 'Missing bearer token' },
      { status: 401 },
    );
  }

  const ctx
    = (await resolveFromToken(jwt)) ?? (await resolveFromUser(jwt));

  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  // Epoch enforcement for /pos/me:
  // - The client always sends X-Pos-Session-Epoch on every request.
  // - If the stored epoch is stale (DB epoch > client epoch), return 401
  //   session_revoked. This covers both single-active-device (another device
  //   logged in) and admin force-logout (both bump the epoch).
  const knownEpochRaw = req.headers.get('x-pos-session-epoch');
  const knownEpoch
    = knownEpochRaw != null && knownEpochRaw !== ''
      ? Number.parseInt(knownEpochRaw, 10)
      : null;

  if (
    knownEpoch != null
    && Number.isFinite(knownEpoch)
    && ctx.sessionEpoch > knownEpoch
  ) {
    return NextResponse.json(
      { error: 'Sesión revocada', code: 'session_revoked' },
      { status: 401 },
    );
  }

  const orgId = ctx.organizationId;

  const [
    businessName,
    businessPhone,
    fiadoEnabledRaw,
    fiadoTermDays,
    paymentMethods,
    cashiers,
    products,
  ] = await Promise.all([
    getSetting(orgId, 'business_name'),
    getSetting(orgId, 'business_phone'),
    getSetting(orgId, 'fiado-enabled'),
    getDefaultTermDays(db, orgId),
    listActivePaymentMethods(orgId),
    listCashiers(orgId),
    db
      .select()
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
          eq(productsSchema.status, 'published'),
        ),
      )
      .orderBy(asc(productsSchema.name)),
  ]);

  const fiadoEnabled = fiadoEnabledRaw === 'true';

  // Wire contract: the POS reads snake_case fields (unit_type, is_wholesale,
  // wholesale_tiers with min_qty). Map explicitly instead of dumping raw drizzle
  // rows — the camelCase keys silently broke kg products and wholesale pricing.
  const wireProducts = products.map(p => ({
    id: p.id,
    name: p.name,
    barcode: p.barcode,
    price: p.price,
    cost: p.cost,
    // Digital products report a virtual stock: the remaining sales limit, or an
    // effectively-infinite count when unlimited — so the POS cart caps work
    // unchanged. The sale endpoints stay authoritative.
    stock: p.isDigital ? (p.digitalLimit ?? 999999) : p.stock,
    category: p.category,
    unit_type: p.unitType,
    attributes: p.attributes,
    is_wholesale: p.isWholesale,
    is_digital: p.isDigital,
    wholesale_tiers: parseWholesaleTiers(p.wholesaleTiers).map(t => ({
      min_qty: t.minQty,
      price: t.price,
    })),
    status: p.status,
    publish_at: p.publishAt,
  }));

  // El método "Fiado" (type credit) se controla por el toggle fiado-enabled, no
  // por su columna active. Si el toggle está apagado, no debe llegar al cajero
  // como opción de pago aunque la fila siga active = true.
  const visiblePaymentMethods = fiadoEnabled
    ? paymentMethods
    : paymentMethods.filter(
        pm => (pm as { type?: string }).type !== 'credit',
      );

  return NextResponse.json({
    cash: ctx.cash,
    sessionEpoch: ctx.sessionEpoch,
    store: {
      id: orgId,
      name: businessName || 'Mi Tienda',
      phone: businessPhone || '',
      fiadoEnabled,
      // Org default payment term: new fiados fall due this many days after
      // the sale unless an explicit due date is provided.
      fiadoTermDays,
    },
    features: {
      fiadoEnabled,
      sellByWeight: true,
      sellDigital: true,
      wholesale: true,
      canConfirmTransfers: ctx.canConfirmTransfers,
    },
    paymentMethods: visiblePaymentMethods,
    cashiers,
    products: wireProducts,
    serverTime: new Date().toISOString(),
  });
}
