import bcrypt from 'bcryptjs';
import { and, eq, gt } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { hashActivationToken } from '@/libs/pos-pin-activation';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { token?: string; pin?: string };

// PUBLIC endpoint — no cashier/clerk auth. Gated ONLY by the one-time activation
// token the admin sent over WhatsApp. The employee opens the link and sets their
// OWN PIN here. CORS + no-auth passthrough is granted in proxy.ts
// (POS_DEVICE_FREE_PATHS). This is the ONLY way a "pendiente de activar" cashier
// gets a PIN and becomes selectable in the POS.
export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const token = body.token?.trim() ?? '';
  const pin = (body.pin ?? '').trim();

  // App-wide PIN rule (matches set-pin / updateMyPin): 4 to 8 digits.
  if (!/^\d{4,8}$/.test(pin)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_pin', error: 'El PIN debe tener entre 4 y 8 dígitos' },
      { status: 400 },
    );
  }
  if (!token) {
    return NextResponse.json(
      { ok: false, code: 'invalid_or_expired', error: 'El enlace no es válido o ya expiró.' },
      { status: 400 },
    );
  }

  // Deterministic SHA-256 lookup: find the row whose stored hash matches AND the
  // link hasn't expired. The 256-bit token entropy makes guessing infeasible, so
  // an equality lookup is safe (no need to scan every row with a slow compare).
  const tokenHash = hashActivationToken(token);
  const [emp] = await db
    .select({
      id: posUsersSchema.id,
      organizationId: posUsersSchema.organizationId,
      name: posUsersSchema.name,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.activationToken, tokenHash),
        gt(posUsersSchema.activationExpiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!emp) {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_or_expired',
        error: 'El enlace no es válido o ya expiró. Pide al admin que te reenvíe uno.',
      },
      { status: 400 },
    );
  }

  const pinHash = await bcrypt.hash(pin, 10);

  // Set the PIN and clear the token (single-use: the next lookup finds nothing) +
  // reset any lockout so the employee can immediately enter with their new PIN.
  await db
    .update(posUsersSchema)
    .set({
      pin: pinHash,
      activationToken: null,
      activationExpiresAt: null,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    })
    .where(eq(posUsersSchema.id, emp.id));

  logAction({
    organizationId: emp.organizationId,
    actor: { type: 'cashier', id: emp.id },
    action: 'employee.pin_activated',
    entityType: 'pos_user',
    entityId: emp.id,
    metadata: { employeeName: emp.name },
  }).catch(() => null);

  return NextResponse.json({ ok: true, name: emp.name });
}
