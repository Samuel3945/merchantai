import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

const { ensureOwnerCashier } = await import('./owner-cashier');
const { posUsersSchema } = await import('@/models/Schema');

// The mocked pglite drizzle instance satisfies the executor at runtime but not
// structurally at compile time (different driver generics); cast at the boundary.
type ExecArg = Parameters<typeof ensureOwnerCashier>[0];
const execDb = () => h.db as unknown as ExecArg;

const ORG = 'org_owner_cashier_test';

// Mirror the FULL pos_users table: a Drizzle insert lists EVERY schema column
// (defaulted ones included), and email is UNIQUE — so a partial DDL fails 42703.
const SCHEMA = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    pin text DEFAULT '' NOT NULL,
    role text DEFAULT 'cashier' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    permissions jsonb DEFAULT '{}' NOT NULL,
    enabled_modules text[] DEFAULT ARRAY['pos']::text[] NOT NULL,
    can_confirm_transfers boolean DEFAULT true NOT NULL,
    clerk_user_id text,
    panel_access boolean DEFAULT false NOT NULL,
    session_epoch integer DEFAULT 0 NOT NULL,
    salary numeric(12, 2),
    phone text,
    work_schedule jsonb DEFAULT '{}' NOT NULL,
    activation_token text,
    activation_expires_at timestamp,
    pin_failed_attempts integer DEFAULT 0 NOT NULL,
    pin_locked_until timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX pos_users_email_unique_idx ON pos_users (email);
`;

const owner = {
  clerkUserId: 'user_owner_1',
  email: 'owner@shop.co',
  name: 'Dueño Uno',
};

function readOperator(id: string) {
  return h.db
    .select({
      role: posUsersSchema.role,
      active: posUsersSchema.active,
      pin: posUsersSchema.pin,
      email: posUsersSchema.email,
      clerkUserId: posUsersSchema.clerkUserId,
    })
    .from(posUsersSchema)
    .where(eq(posUsersSchema.id, id))
    .then(rows => rows[0]);
}

function countOrg() {
  return h.db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(eq(posUsersSchema.organizationId, ORG))
    .then(rows => rows.length);
}

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM pos_users;');
});

describe('ensureOwnerCashier', () => {
  it('provisions a fresh ADMIN operator for the owner with the given PIN', async () => {
    const r = await ensureOwnerCashier(execDb(), ORG, owner, '1234');

    expect(r.name).toBe('Dueño Uno');

    const row = await readOperator(r.id);

    expect(row?.role).toBe('admin');
    expect(row?.active).toBe(true);
    expect(row?.clerkUserId).toBe('user_owner_1');
    expect(row?.pin).not.toBe(''); // bcrypt hash, not the raw pin
    expect(row?.pin).not.toBe('1234');
    // A SYNTHETIC email (per Clerk id), never the owner's real one — pos_users.email
    // is globally unique, so a real-email row could collide across orgs.
    expect(row?.email).toBe('owner-user_owner_1@operator.local');
    expect(row?.email).not.toBe('owner@shop.co');
  });

  it('is idempotent: a second call reuses the operator, never duplicates', async () => {
    const a = await ensureOwnerCashier(execDb(), ORG, owner, '1234');
    const b = await ensureOwnerCashier(execDb(), ORG, owner, '9999');

    expect(b.id).toBe(a.id);
    expect(await countOrg()).toBe(1);
  });

  it('never silently overwrites an existing PIN', async () => {
    const a = await ensureOwnerCashier(execDb(), ORG, owner, '1234');
    const before = await readOperator(a.id);

    await ensureOwnerCashier(execDb(), ORG, owner, '9999');
    const after = await readOperator(a.id);

    expect(after?.pin).toBe(before?.pin);
  });

  it('adopts an existing same-email row: links Clerk id + promotes to admin', async () => {
    await pg.query(
      `INSERT INTO pos_users (organization_id, name, email, password_hash, pin, role, active)
       VALUES ($1, 'Dueño Uno', 'owner@shop.co', 'x', '', 'employee', true)`,
      [ORG],
    );

    const r = await ensureOwnerCashier(execDb(), ORG, owner, '1234');

    expect(await countOrg()).toBe(1); // adopted, not duplicated

    const row = await readOperator(r.id);

    expect(row?.role).toBe('admin');
    expect(row?.clerkUserId).toBe('user_owner_1');
  });
});
