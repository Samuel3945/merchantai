import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { loginCashier } from '@/libs/cashier-session';
import { db } from '@/libs/DB';
import { employeeInvitationsSchema, posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AcceptBody = {
  token?: string;
  name?: string;
  password?: string;
};

export async function POST(req: Request): Promise<NextResponse> {
  let body: AcceptBody;
  try {
    body = (await req.json()) as AcceptBody;
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400 },
    );
  }

  const token = body.token?.trim();
  const name = body.name?.trim();
  const password = body.password ?? '';

  if (!token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: 'missing_name' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'weak_password' }, { status: 400 });
  }

  const [invitation] = await db
    .select()
    .from(employeeInvitationsSchema)
    .where(eq(employeeInvitationsSchema.token, token))
    .limit(1);

  if (!invitation) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (invitation.status !== 'pending') {
    return NextResponse.json(
      { error: `invitation_${invitation.status}` },
      { status: 410 },
    );
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await db
      .update(employeeInvitationsSchema)
      .set({ status: 'expired' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await db.transaction(async (tx) => {
    await tx
      .update(posUsersSchema)
      .set({ name, passwordHash, active: true })
      .where(eq(posUsersSchema.id, invitation.userId));

    await tx
      .update(employeeInvitationsSchema)
      .set({ status: 'accepted' })
      .where(eq(employeeInvitationsSchema.id, invitation.id));
  });

  const session = await loginCashier(invitation.email, password);

  return NextResponse.json({
    ok: true,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    user: session.user,
  });
}
