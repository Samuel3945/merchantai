import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { posTokensSchema, posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// La caja (token de dispositivo) no expira por tiempo: persiste hasta que el
// admin revoque/regenere el token. Si el admin setea pos_tokens.expiresAt, se
// respeta esa fecha (ver chequeo de expiresAt más abajo). 10 años = "no expira".
const SESSION_TTL_S = 10 * 365 * 24 * 3600;

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LoginBody = { code?: string; pin?: string };

type CashPayload = {
  id: string;
  displayCode: string;
  deviceName: string;
  cashierId: string | null;
  label: string;
};

function buildCashFromToken(
  tokenRow: typeof posTokensSchema.$inferSelect,
  cashierName: string | null,
): CashPayload {
  const deviceName = tokenRow.deviceName;
  return {
    id: tokenRow.id,
    displayCode: deviceName.slice(0, 12),
    deviceName,
    cashierId: tokenRow.cashierId,
    label: cashierName || deviceName,
  };
}

function buildCashFromUser(
  user: typeof posUsersSchema.$inferSelect,
): CashPayload {
  const deviceName = user.name;
  return {
    id: user.id,
    displayCode: deviceName.slice(0, 12),
    deviceName,
    cashierId: user.id,
    label: user.name || deviceName,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const code = body.code?.trim();
  const pin = body.pin ?? '';
  if (!code) {
    return NextResponse.json(
      { success: false, error: 'code is required' },
      { status: 400 },
    );
  }

  if (UUID_RE.test(code)) {
    const [row] = await db
      .select({
        token: posTokensSchema,
        cashierName: posUsersSchema.name,
      })
      .from(posTokensSchema)
      .leftJoin(
        posUsersSchema,
        eq(posUsersSchema.id, posTokensSchema.cashierId),
      )
      .where(
        and(
          eq(posTokensSchema.token, code),
          eq(posTokensSchema.active, true),
        ),
      )
      .limit(1);

    if (row) {
      if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) {
        return NextResponse.json(
          { success: false, error: 'Token expirado' },
          { status: 401 },
        );
      }

      // PIN de acceso de la caja: si está configurado, se exige junto al token.
      if (row.token.pin) {
        const valid = await bcrypt.compare(pin, row.token.pin);
        if (!valid) {
          return NextResponse.json(
            {
              success: false,
              error: 'PIN de la caja incorrecto',
              needsPin: true,
            },
            { status: 401 },
          );
        }
      }

      return NextResponse.json({
        success: true,
        jwt: row.token.token,
        expiresInS: SESSION_TTL_S,
        cash: buildCashFromToken(row.token, row.cashierName),
      });
    }
  }

  const normalizedEmail = code.toLowerCase();
  const [user] = await db
    .select()
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.email, normalizedEmail),
        eq(posUsersSchema.active, true),
      ),
    )
    .limit(1);

  if (user) {
    const valid = await bcrypt.compare(pin, user.passwordHash);
    if (valid) {
      return NextResponse.json({
        success: true,
        jwt: user.id,
        expiresInS: SESSION_TTL_S,
        cash: buildCashFromUser(user),
      });
    }
  }

  return NextResponse.json(
    { success: false, error: 'Código inválido o inactivo' },
    { status: 401 },
  );
}
