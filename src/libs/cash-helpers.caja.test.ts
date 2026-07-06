/**
 * Integración (PGlite) del arqueo por CAJA (Fase 2):
 *  - dos dispositivos que comparten una caja usan UNA sola sesión
 *  - findOrCreateOpenSession no duplica la sesión de una caja compartida
 *  - un dispositivo con su propia caja (individual) no ve la sesión de otra
 */

import type * as CashHelpers from '@/libs/cash-helpers';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Executor = Parameters<typeof CashHelpers.resolveDeviceCajaId>[0];

const h = vi.hoisted(() => ({
  db: null as unknown as Executor,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

const { findOpenSession, findOrCreateOpenSession, resolveDeviceCajaId }
  = await import('@/libs/cash-helpers');

const SETUP_SQL = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');

  CREATE TABLE cajas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL
  );

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    caja_id uuid
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
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text,
    client_session_id uuid,
    opened_by_actor_id text,
    closed_by_actor_id text,
    caja_id uuid
  );
`;

const ORG = 'org-caja-test';
const CAJA_SHARED = '00000000-0000-0000-0000-00000000ca01';
const CAJA_D = '00000000-0000-0000-0000-00000000ca02';
const DEV_A = '00000000-0000-0000-0000-0000000000a1';
const DEV_B = '00000000-0000-0000-0000-0000000000b2';
const DEV_D = '00000000-0000-0000-0000-0000000000d4';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg) as unknown as Executor;
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM cajas');
  await pg.exec(
    `INSERT INTO cajas (id, organization_id) VALUES ('${CAJA_SHARED}', '${ORG}'), ('${CAJA_D}', '${ORG}')`,
  );
  // A y B comparten la caja CAJA_SHARED; D tiene la suya.
  await pg.exec(
    `INSERT INTO pos_tokens (id, organization_id, caja_id) VALUES
      ('${DEV_A}', '${ORG}', '${CAJA_SHARED}'),
      ('${DEV_B}', '${ORG}', '${CAJA_SHARED}'),
      ('${DEV_D}', '${ORG}', '${CAJA_D}')`,
  );
});

describe('arqueo por caja', () => {
  it('resolveDeviceCajaId devuelve la caja del dispositivo', async () => {
    expect(await resolveDeviceCajaId(h.db, ORG, DEV_A)).toBe(CAJA_SHARED);
    expect(await resolveDeviceCajaId(h.db, ORG, DEV_D)).toBe(CAJA_D);
  });

  it('dos dispositivos de una caja compartida comparten UNA sola sesión', async () => {
    // A abre la caja.
    const opened = await findOrCreateOpenSession(h.db, {
      organizationId: ORG,
      openedBy: 'A',
      posTokenId: DEV_A,
    });

    expect(opened.cajaId).toBe(CAJA_SHARED);

    // B ve la MISMA sesión (no la suya).
    const seenByB = await findOpenSession(h.db, ORG, DEV_B);

    expect(seenByB?.id).toBe(opened.id);
  });

  it('findOrCreateOpenSession no duplica la sesión de una caja compartida', async () => {
    const s1 = await findOrCreateOpenSession(h.db, {
      organizationId: ORG,
      openedBy: 'A',
      posTokenId: DEV_A,
    });
    // B "abre" pero ya está abierta → obtiene la misma, no crea otra.
    const s2 = await findOrCreateOpenSession(h.db, {
      organizationId: ORG,
      openedBy: 'B',
      posTokenId: DEV_B,
    });

    expect(s2.id).toBe(s1.id);

    const { rows } = await pg.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cash_sessions WHERE status='open'`,
    );

    expect(rows[0]!.n).toBe('1');
  });

  it('un dispositivo con su propia caja no ve la sesión de otra caja', async () => {
    await findOrCreateOpenSession(h.db, {
      organizationId: ORG,
      openedBy: 'A',
      posTokenId: DEV_A,
    });

    // D tiene otra caja → no hay sesión abierta para él.
    expect(await findOpenSession(h.db, ORG, DEV_D)).toBeUndefined();
  });
});
