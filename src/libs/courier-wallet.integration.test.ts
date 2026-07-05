/**
 * Integración (PGlite) del bolsillo del domiciliario — invariantes de dinero:
 *  - base/entrega escriben el cash_movement del cajón (arqueo cuadra solo)
 *  - la venta a domicilio en efectivo se desvía net-0 del cajón al bolsillo
 *  - idempotencia del desvío por saleId
 *  - reconciliación: una entrega que sincroniza tras cerrar recalcula el arqueo
 */

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

const {
  getCourierBalance,
  listActiveCourierWalletBalances,
  recordCourierCashMovement,
  recordDeliveryCashCollected,
} = await import('@/libs/courier-wallet');

const SETUP_SQL = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','credito_payment','reclassification');
  CREATE TYPE "courier_cash_direction" AS ENUM('base_from_caja','sale_collected','handover_to_caja');

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    enabled_modules text[] DEFAULT ARRAY['pos']::text[] NOT NULL
  );

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL
  );

  CREATE TABLE sale_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL
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
    closed_by_actor_id text
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE courier_shifts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    courier_id uuid NOT NULL,
    pos_token_id uuid,
    started_at timestamp DEFAULT now() NOT NULL,
    ended_at timestamp
  );

  CREATE TABLE courier_cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    shift_id uuid,
    courier_id uuid NOT NULL,
    pos_token_id uuid,
    direction "courier_cash_direction" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    sale_id uuid,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    client_movement_id uuid
  );
`;

const ORG = 'org-courier-test';
const TOKEN = '00000000-0000-0000-0000-0000000000aa';
const COURIER = '00000000-0000-0000-0000-0000000000bb';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM courier_cash_movements');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM courier_shifts');
  await pg.exec('DELETE FROM sale_payments');
  await pg.exec('DELETE FROM sales');
  await pg.exec('DELETE FROM pos_users');
  await pg.exec(
    `INSERT INTO pos_users (id, organization_id, name, active, enabled_modules)
     VALUES ('${COURIER}', '${ORG}', 'Domi Uno', true, ARRAY['pos','delivery']::text[])`,
  );
});

async function openSession(): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO cash_sessions (organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ('${ORG}', '${TOKEN}', 'tester', '0', 'open') RETURNING id`,
  );
  return r.rows[0]!.id;
}

async function cashExpected(sessionId: string): Promise<number> {
  const r = await pg.query<{ exp: string }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type IN ('sale','deposit','adjustment','credito_payment')),0)
          - COALESCE(SUM(amount) FILTER (WHERE type IN ('expense','salary','inventory_purchase','withdrawal','advance')),0)
          AS exp
     FROM cash_movements WHERE session_id = '${sessionId}'`,
  );
  return Number.parseFloat(r.rows[0]!.exp);
}

describe('recordCourierCashMovement', () => {
  it('base_from_caja: saca del cajón y sube el saldo del domiciliario', async () => {
    await openSession();
    await recordCourierCashMovement({
      orgId: ORG,
      courierId: COURIER,
      direction: 'base_from_caja',
      amount: 50000,
      posTokenId: TOKEN,
    });

    expect(await getCourierBalance(ORG, COURIER)).toBe(50000);

    const session = (
      await pg.query<{ id: string }>(`SELECT id FROM cash_sessions LIMIT 1`)
    ).rows[0]!.id;

    // El cajón bajó 50000 (withdrawal).
    expect(await cashExpected(session)).toBe(-50000);
  });

  it('handover_to_caja: entra al cajón y baja el saldo del domiciliario', async () => {
    const session = await openSession();
    await recordCourierCashMovement({
      orgId: ORG,
      courierId: COURIER,
      direction: 'base_from_caja',
      amount: 50000,
      posTokenId: TOKEN,
    });
    await recordCourierCashMovement({
      orgId: ORG,
      courierId: COURIER,
      direction: 'handover_to_caja',
      amount: 30000,
      posTokenId: TOKEN,
    });

    expect(await getCourierBalance(ORG, COURIER)).toBe(20000);
    // Cajón: −50000 (base) + 30000 (entrega) = −20000.
    expect(await cashExpected(session)).toBe(-20000);
  });

  it('es idempotente por clientMovementId', async () => {
    await openSession();
    const args = {
      orgId: ORG,
      courierId: COURIER,
      direction: 'base_from_caja' as const,
      amount: 10000,
      posTokenId: TOKEN,
      clientMovementId: '00000000-0000-0000-0000-0000000000c1',
    };
    await recordCourierCashMovement(args);
    await recordCourierCashMovement(args);

    expect(await getCourierBalance(ORG, COURIER)).toBe(10000);
  });
});

describe('recordDeliveryCashCollected', () => {
  async function seedCashSale(sessionId: string, cash: number): Promise<string> {
    const sale = (
      await pg.query<{ id: string }>(
        `INSERT INTO sales (organization_id) VALUES ('${ORG}') RETURNING id`,
      )
    ).rows[0]!.id;
    await pg.exec(
      `INSERT INTO sale_payments (sale_id, method, amount) VALUES ('${sale}', 'efectivo', '${cash}')`,
    );
    // La venta ya cayó al cajón como un cash_movement 'sale' (createSaleForOrg).
    await pg.exec(
      `INSERT INTO cash_movements (session_id, organization_id, type, amount, reason, created_by, sale_id)
       VALUES ('${sessionId}', '${ORG}', 'sale', '${cash}', 'Venta', 'system', '${sale}')`,
    );
    return sale;
  }

  it('desvía net-0 del cajón al bolsillo del domiciliario', async () => {
    const session = await openSession();
    const sale = await seedCashSale(session, 40000);
    await recordDeliveryCashCollected({
      orgId: ORG,
      saleId: sale,
      courierId: COURIER,
      posTokenId: TOKEN,
    });

    // Cajón: +40000 (venta) −40000 (compensación) = 0.
    expect(await cashExpected(session)).toBe(0);
    // Bolsillo del domiciliario: +40000.
    expect(await getCourierBalance(ORG, COURIER)).toBe(40000);
  });

  it('es idempotente por saleId (no duplica el desvío)', async () => {
    const session = await openSession();
    const sale = await seedCashSale(session, 40000);
    await recordDeliveryCashCollected({ orgId: ORG, saleId: sale, courierId: COURIER, posTokenId: TOKEN });
    await recordDeliveryCashCollected({ orgId: ORG, saleId: sale, courierId: COURIER, posTokenId: TOKEN });

    expect(await getCourierBalance(ORG, COURIER)).toBe(40000);
    expect(await cashExpected(session)).toBe(0);
  });

  it('no desvía nada si la venta no tuvo efectivo', async () => {
    await openSession();
    const sale = (
      await pg.query<{ id: string }>(
        `INSERT INTO sales (organization_id) VALUES ('${ORG}') RETURNING id`,
      )
    ).rows[0]!.id;
    await pg.exec(
      `INSERT INTO sale_payments (sale_id, method, amount) VALUES ('${sale}', 'tarjeta', '40000')`,
    );
    const res = await recordDeliveryCashCollected({ orgId: ORG, saleId: sale, courierId: COURIER, posTokenId: TOKEN });

    expect(res).toBeNull();
    expect(await getCourierBalance(ORG, COURIER)).toBe(0);
  });
});

describe('reconciliación al cerrar con excedente', () => {
  it('una entrega que sincroniza tras cerrar deja el arqueo exacto', async () => {
    const session = await openSession();
    // El cajón cierra: el cajero contó 30000 físicos (incluye una entrega del
    // domiciliario que aún no sincronizó) → expected 0 → excedente +30000.
    await pg.exec(
      `UPDATE cash_sessions SET status='closed', closed_at=now(), counted_amount='30000',
        expected_amount='0', difference='30000' WHERE id='${session}'`,
    );
    // Sube la entrega del domiciliario (offline) DESPUÉS del cierre.
    await recordCourierCashMovement({
      orgId: ORG,
      courierId: COURIER,
      direction: 'handover_to_caja',
      amount: 30000,
      posTokenId: TOKEN,
    });
    const r = await pg.query<{ expected_amount: string; difference: string }>(
      `SELECT expected_amount, difference FROM cash_sessions WHERE id='${session}'`,
    );

    // Ahora expected=30000 y difference=0 (exacto).
    expect(Number.parseFloat(r.rows[0]!.expected_amount)).toBe(30000);
    expect(Number.parseFloat(r.rows[0]!.difference)).toBe(0);
  });
});

describe('listActiveCourierWalletBalances', () => {
  it('lista solo domiciliarios activos con su saldo', async () => {
    await openSession();
    await recordCourierCashMovement({
      orgId: ORG,
      courierId: COURIER,
      direction: 'base_from_caja',
      amount: 25000,
      posTokenId: TOKEN,
    });
    const list = await listActiveCourierWalletBalances(ORG);

    expect(list).toEqual([
      { courierId: COURIER, name: 'Domi Uno', balance: 25000 },
    ]);
  });
});
