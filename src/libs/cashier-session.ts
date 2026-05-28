import bcrypt from 'bcryptjs';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { posSessionsSchema, posUsersSchema } from '@/models/Schema';

const SESSION_TTL_HOURS = 12;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

export type CashierAuthUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'admin' | 'cashier' | 'employee';
  permissions: Record<string, unknown>;
  enabledModules: string[];
  canConfirmTransfers: boolean;
};

export type CashierSession = {
  sessionId: string;
  expiresAt: string;
  user: CashierAuthUser;
};

function toUser(row: typeof posUsersSchema.$inferSelect): CashierAuthUser {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    email: row.email,
    role: row.role,
    permissions: (row.permissions ?? {}) as Record<string, unknown>,
    enabledModules: row.enabledModules ?? [],
    canConfirmTransfers: row.canConfirmTransfers,
  };
}

export async function loginCashier(
  email: string,
  password: string,
): Promise<CashierSession> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) {
    throw new Error('Email y contraseña son requeridos');
  }

  const [row] = await db
    .select()
    .from(posUsersSchema)
    .where(
      and(eq(posUsersSchema.email, normalized), eq(posUsersSchema.active, true)),
    )
    .limit(1);

  if (!row) {
    throw new Error('Credenciales inválidas');
  }

  const valid = await bcrypt.compare(password, row.passwordHash);
  if (!valid) {
    throw new Error('Credenciales inválidas');
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const [session] = await db
    .insert(posSessionsSchema)
    .values({ userId: row.id, expiresAt })
    .returning({
      id: posSessionsSchema.id,
      expiresAt: posSessionsSchema.expiresAt,
    });

  if (!session) {
    throw new Error('No se pudo crear la sesión');
  }

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    user: toUser(row),
  };
}

export async function logoutCashier(sessionId: string): Promise<void> {
  if (!sessionId) {
    return;
  }
  await db.delete(posSessionsSchema).where(eq(posSessionsSchema.id, sessionId));
}

export async function resolveCashierSession(
  sessionId: string,
): Promise<CashierSession | null> {
  if (!sessionId) {
    return null;
  }

  const [row] = await db
    .select({
      session: {
        id: posSessionsSchema.id,
        expiresAt: posSessionsSchema.expiresAt,
      },
      user: posUsersSchema,
    })
    .from(posSessionsSchema)
    .innerJoin(posUsersSchema, eq(posUsersSchema.id, posSessionsSchema.userId))
    .where(
      and(
        eq(posSessionsSchema.id, sessionId),
        gt(posSessionsSchema.expiresAt, new Date()),
        eq(posUsersSchema.active, true),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session.id,
    expiresAt: row.session.expiresAt.toISOString(),
    user: toUser(row.user),
  };
}
