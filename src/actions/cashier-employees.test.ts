import { PGlite } from '@electric-sql/pglite';
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

const { countActiveCashierEmployees } = await import('./pos-tokens');

const ORG = 'org_cashier_emp_test';

// Full pos_users DDL — a Drizzle query references every schema column.
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
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX pos_users_email_unique_idx ON pos_users (email);
`;

let pg: PGlite;

async function insertUser(args: {
  email: string;
  role: string;
  active: boolean;
  modules: string[];
  org?: string;
}) {
  await pg.query(
    `INSERT INTO pos_users (organization_id, name, email, password_hash, role, active, enabled_modules)
     VALUES ($1, $2, $3, 'x', $4, $5, $6)`,
    [args.org ?? ORG, args.email, args.email, args.role, args.active, args.modules],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM pos_users;');
});

describe('countActiveCashierEmployees', () => {
  it('counts only ACTIVE, NON-admin operators with the pos module', async () => {
    await insertUser({ email: 'admin@x.co', role: 'admin', active: true, modules: ['pos'] }); // excluded: admin
    await insertUser({ email: 'ana@x.co', role: 'cashier', active: true, modules: ['pos'] }); // counts
    await insertUser({ email: 'beto@x.co', role: 'employee', active: true, modules: ['pos'] }); // counts
    await insertUser({ email: 'sin-pos@x.co', role: 'employee', active: true, modules: ['inventory'] }); // excluded: no pos
    await insertUser({ email: 'inactivo@x.co', role: 'cashier', active: false, modules: ['pos'] }); // excluded: inactive
    await insertUser({ email: 'otra-org@x.co', role: 'cashier', active: true, modules: ['pos'], org: 'org_other' }); // excluded: other org

    expect(await countActiveCashierEmployees(ORG)).toBe(2);
  });

  it('returns 0 when only the admin can run the POS (the toggle-off guard case)', async () => {
    await insertUser({ email: 'admin@x.co', role: 'admin', active: true, modules: ['pos'] });

    expect(await countActiveCashierEmployees(ORG)).toBe(0);
  });
});
