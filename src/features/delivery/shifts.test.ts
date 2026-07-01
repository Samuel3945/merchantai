/**
 * Courier shift actions — the delivery money-core bridge.
 *
 * Covers: starting a shift against an OPEN caja, rejecting a caja that is not
 * open, the idempotent same-caja start, switching caja (ends the old shift), and
 * ending a shift. Uses an in-memory PGlite db and mocks Clerk auth (org:admin so
 * requirePanelModule passes) + getCurrentPanelUser resolves via the seeded
 * pos_users row.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_shifts_test';
const CLERK_ID = 'user_courier_clerk';
const COURIER_ID = 'aaaaaaaa-0001-4001-8001-000000000001';
const DEVICE_ID = 'aaaaaaaa-0002-4002-8002-000000000002';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  // Literals (not the module consts) — vi.hoisted runs before those are initialized.
  auth: {
    userId: 'user_courier_clerk' as string | null,
    orgId: 'org_shifts_test' as string | null,
    orgRole: 'org:admin' as string,
  },
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => h.auth),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const SCHEMA = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text,
    enabled_modules text[] DEFAULT '{}' NOT NULL,
    clerk_user_id text,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status text DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text,
    client_session_id uuid,
    opened_by_actor_id text,
    closed_by_actor_id text
  );

  CREATE TABLE courier_shifts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    courier_id uuid NOT NULL,
    pos_token_id uuid,
    started_at timestamp DEFAULT now() NOT NULL,
    ended_at timestamp
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  await pg.query(
    `INSERT INTO pos_users (id, organization_id, name, clerk_user_id, active)
     VALUES ($1, $2, 'Cami Courier', $3, true)`,
    [COURIER_ID, ORG, CLERK_ID],
  );
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name, active)
     VALUES ($1, $2, 'Caja Mostrador', true)`,
    [DEVICE_ID, ORG],
  );
});

beforeEach(async () => {
  h.auth = { userId: CLERK_ID, orgId: ORG, orgRole: 'org:admin' };
  await pg.exec('DELETE FROM courier_shifts; DELETE FROM cash_sessions;');
});

async function openSession(posTokenId: string | null): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions (organization_id, pos_token_id, opened_by, status)
     VALUES ($1, $2, 'owner', 'open')`,
    [ORG, posTokenId],
  );
}

describe('courier shift actions', () => {
  it('startCourierShift on an OPEN device caja creates one active shift', async () => {
    await openSession(DEVICE_ID);
    const { startCourierShift } = await import('./shifts');

    const shift = await startCourierShift(DEVICE_ID);

    expect(shift.posTokenId).toBe(DEVICE_ID);
    expect(shift.cajaLabel).toBe('Caja Mostrador');

    const rows = (
      await pg.query(
        `SELECT courier_id, pos_token_id, ended_at FROM courier_shifts WHERE organization_id = $1`,
        [ORG],
      )
    ).rows as Array<{ courier_id: string; pos_token_id: string; ended_at: unknown }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.courier_id).toBe(COURIER_ID);
    expect(rows[0]!.pos_token_id).toBe(DEVICE_ID);
    expect(rows[0]!.ended_at).toBeNull();
  });

  it('startCourierShift on the admin caja (posTokenId null) works when its session is open', async () => {
    await openSession(null);
    const { startCourierShift } = await import('./shifts');

    const shift = await startCourierShift(null);

    expect(shift.posTokenId).toBeNull();
    expect(shift.cajaLabel).toBe('Caja administración');
  });

  it('startCourierShift throws when the chosen caja is NOT open', async () => {
    // No open session seeded for DEVICE_ID.
    const { startCourierShift } = await import('./shifts');

    await expect(startCourierShift(DEVICE_ID)).rejects.toThrow(/no está abierta/i);

    const count = (
      await pg.query(`SELECT count(*)::int AS c FROM courier_shifts`)
    ).rows as Array<{ c: number }>;

    expect(count[0]!.c).toBe(0);
  });

  it('startCourierShift on the SAME caja is idempotent (no duplicate shift)', async () => {
    await openSession(DEVICE_ID);
    const { startCourierShift } = await import('./shifts');

    const first = await startCourierShift(DEVICE_ID);
    const second = await startCourierShift(DEVICE_ID);

    expect(second.id).toBe(first.id);

    const count = (
      await pg.query(
        `SELECT count(*)::int AS c FROM courier_shifts WHERE ended_at IS NULL`,
      )
    ).rows as Array<{ c: number }>;

    expect(count[0]!.c).toBe(1);
  });

  it('switching caja ends the previous shift and starts a new active one', async () => {
    await openSession(DEVICE_ID);
    await openSession(null);
    const { startCourierShift } = await import('./shifts');

    await startCourierShift(DEVICE_ID);
    await startCourierShift(null);

    const active = (
      await pg.query(
        `SELECT pos_token_id FROM courier_shifts WHERE ended_at IS NULL`,
      )
    ).rows as Array<{ pos_token_id: string | null }>;
    const ended = (
      await pg.query(
        `SELECT count(*)::int AS c FROM courier_shifts WHERE ended_at IS NOT NULL`,
      )
    ).rows as Array<{ c: number }>;

    expect(active).toHaveLength(1);
    expect(active[0]!.pos_token_id).toBeNull();
    expect(ended[0]!.c).toBe(1);
  });

  it('getActiveCourierShift returns the active shift with its caja label', async () => {
    await openSession(DEVICE_ID);
    const { startCourierShift, getActiveCourierShift } = await import('./shifts');

    await startCourierShift(DEVICE_ID);
    const active = await getActiveCourierShift();

    expect(active).not.toBeNull();
    expect(active!.posTokenId).toBe(DEVICE_ID);
    expect(active!.cajaLabel).toBe('Caja Mostrador');
  });

  it('endCourierShift stamps ended_at on the active shift', async () => {
    await openSession(DEVICE_ID);
    const { startCourierShift, endCourierShift, getActiveCourierShift }
      = await import('./shifts');

    await startCourierShift(DEVICE_ID);
    await endCourierShift();

    expect(await getActiveCourierShift()).toBeNull();

    const count = (
      await pg.query(
        `SELECT count(*)::int AS c FROM courier_shifts WHERE ended_at IS NOT NULL`,
      )
    ).rows as Array<{ c: number }>;

    expect(count[0]!.c).toBe(1);
  });

  it('listOpenCajas returns only open DEVICE cajas, excluding the admin caja', async () => {
    await openSession(DEVICE_ID);
    await openSession(null); // admin/dashboard session — must NOT be offered

    const { listOpenCajas } = await import('./shifts');

    const cajas = await listOpenCajas();

    // The admin/dashboard caja (posTokenId null) is a system fallback the shop
    // never explicitly opens, so it must not appear as a pickable courier caja.
    expect(cajas).toHaveLength(1);
    expect(cajas[0]!.posTokenId).toBe(DEVICE_ID);
    expect(cajas.map(c => c.label)).toEqual(['Caja Mostrador']);
    expect(cajas.some(c => c.posTokenId === null)).toBe(false);
  });
});
