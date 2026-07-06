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

const { ensureCajaForDevice } = await import('./cajas');
const { nextRegisterCajaName } = await import('@/libs/caja-naming');

type Executor = Parameters<typeof nextRegisterCajaName>[0];
const asExecutor = () => h.db as unknown as Executor;

const ORG = 'org_cajas_naming_test';

// cajas + pos_tokens DDL. Both tables carry every column the Drizzle schema
// touches, incl. the new archived_at added in migration 0093.
const SCHEMA = `
  CREATE TABLE cajas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'register' NOT NULL,
    courier_id uuid,
    archived boolean DEFAULT false NOT NULL,
    archived_at timestamp,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    caja_id uuid
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg) as unknown as ReturnType<typeof drizzle>;
  await pg.exec(SCHEMA);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM cajas');
});

async function seedCaja(name: string, opts?: { archived?: boolean; type?: string }) {
  await pg.query(
    `INSERT INTO cajas (organization_id, name, type, archived)
     VALUES ($1, $2, $3, $4)`,
    [ORG, name, opts?.type ?? 'register', opts?.archived ?? false],
  );
}

describe('nextRegisterCajaName', () => {
  it('is "Caja 1" when the org has no register cajas', async () => {
    await expect(nextRegisterCajaName(asExecutor(), ORG)).resolves.toBe('Caja 1');
  });

  it('counts ARCHIVED register cajas so numbers are never reused', async () => {
    await seedCaja('Caja 1', { archived: true });
    await seedCaja('Caja 2', { archived: false });

    // 2 register cajas (one archived) → next is Caja 3, not Caja 2.
    await expect(nextRegisterCajaName(asExecutor(), ORG)).resolves.toBe('Caja 3');
  });

  it('ignores courier cajas and other orgs', async () => {
    await seedCaja('Domiciliario', { type: 'courier' });
    await pg.query(
      `INSERT INTO cajas (organization_id, name, type) VALUES ($1, 'Caja X', 'register')`,
      ['other_org'],
    );

    await expect(nextRegisterCajaName(asExecutor(), ORG)).resolves.toBe('Caja 1');
  });
});

describe('ensureCajaForDevice', () => {
  async function insertDevice(id: string) {
    await pg.query(
      `INSERT INTO pos_tokens (id, organization_id) VALUES ($1, $2)`,
      [id, ORG],
    );
  }

  it('names the first device caja "Caja 1" and the second "Caja 2"', async () => {
    const dev1 = '00000000-0000-0000-0000-0000000000d1';
    const dev2 = '00000000-0000-0000-0000-0000000000d2';
    await insertDevice(dev1);
    await insertDevice(dev2);

    await ensureCajaForDevice(ORG, dev1, 'user_1');
    await ensureCajaForDevice(ORG, dev2, 'user_1');

    const rows = await pg.query<{ name: string }>(
      `SELECT c.name FROM cajas c
       JOIN pos_tokens t ON t.caja_id = c.id
       WHERE t.id = ANY($1) ORDER BY c.name`,
      [[dev1, dev2]],
    );

    expect(rows.rows.map(r => r.name)).toEqual(['Caja 1', 'Caja 2']);
  });

  it('is a no-op when the device already has a caja', async () => {
    const dev = '00000000-0000-0000-0000-0000000000d3';
    await insertDevice(dev);
    await seedCaja('Caja 1');
    const cajaId = (
      await pg.query<{ id: string }>(`SELECT id FROM cajas LIMIT 1`)
    ).rows[0]?.id;
    await pg.query(`UPDATE pos_tokens SET caja_id = $1 WHERE id = $2`, [
      cajaId,
      dev,
    ]);

    await ensureCajaForDevice(ORG, dev, 'user_1');

    const count = (
      await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM cajas`)
    ).rows[0]?.n;

    expect(Number(count)).toBe(1);
  });
});
