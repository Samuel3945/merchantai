/**
 * Delivery-fee settlement tests (src/features/delivery/settlement.ts).
 *
 * Covers the credito (fiado) branch: when a delivery is settled fully on
 * credito, the delivery fee must be added to the customer's DEBT — bumping
 * the credito's originalAmount AND recording a `charge` movement — not
 * dropped for the arqueo like the old behavior. Also re-verifies the
 * pre-existing cash/courier_tip paths still work after the branch restructure.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted state ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

// ── PGLite schema ─────────────────────────────────────────────────────────────

const SETUP_SQL = `
  CREATE TYPE "credito_status" AS ENUM('pending', 'paid', 'written_off');
  CREATE TYPE "credito_movement_type" AS ENUM('charge', 'payment', 'extension', 'writeoff', 'adjustment');
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'credito_payment');
  CREATE TYPE "delivery_event_type" AS ENUM('created', 'assigned', 'status_change', 'note', 'customer_notified');
  CREATE TYPE "audit_actor_type" AS ENUM('user', 'courier', 'admin', 'agent', 'system', 'cron');

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    notes text
  );

  CREATE TABLE creditos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid,
    sale_id uuid,
    original_amount numeric(12, 2) NOT NULL,
    due_date date NOT NULL,
    status "credito_status" DEFAULT 'pending' NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX creditos_sale_unique_idx ON creditos (sale_id) WHERE sale_id IS NOT NULL;

  CREATE TABLE credito_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    credito_id uuid NOT NULL REFERENCES creditos(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "credito_movement_type" NOT NULL,
    amount numeric(12, 2) DEFAULT '0' NOT NULL,
    method text,
    cash_movement_id uuid,
    transfer_reconciliation_id uuid,
    due_date_before date,
    due_date_after date,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
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
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text
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

  CREATE TABLE delivery_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL
  );

  CREATE TABLE delivery_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    delivery_order_id uuid NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "delivery_event_type" NOT NULL,
    from_status text,
    to_status text,
    note text,
    actor_type "audit_actor_type" DEFAULT 'user' NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-settlement-test';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM delivery_events');
  await pg.exec('DELETE FROM delivery_orders');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM credito_movements');
  await pg.exec('DELETE FROM creditos');
  await pg.exec('DELETE FROM sales');
  await pg.exec('DELETE FROM app_settings');
  counter = 0;
});

async function seedSale(): Promise<string> {
  counter++;
  const saleId = UUID(counter * 10);
  await pg.query(
    `INSERT INTO sales (id, organization_id) VALUES ($1, $2)`,
    [saleId, ORG],
  );
  return saleId;
}

async function seedDeliveryOrder(): Promise<string> {
  counter++;
  const orderId = UUID(counter * 10 + 1);
  await pg.query(
    `INSERT INTO delivery_orders (id, organization_id) VALUES ($1, $2)`,
    [orderId, ORG],
  );
  return orderId;
}

async function seedCredito(saleId: string, originalAmount: string): Promise<string> {
  counter++;
  const creditoId = UUID(counter * 10 + 2);
  await pg.query(
    `INSERT INTO creditos (id, organization_id, sale_id, original_amount, due_date)
     VALUES ($1, $2, $3, $4, '2026-08-01')`,
    [creditoId, ORG, saleId, originalAmount],
  );
  return creditoId;
}

async function openCashSession(): Promise<string> {
  counter++;
  const sessionId = UUID(counter * 10 + 3);
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, NULL, 'cajero', '0', 'open')`,
    [sessionId, ORG],
  );
  return sessionId;
}

async function setFeeMode(mode: 'revenue' | 'courier_tip'): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, 'delivery_fee_mode', $2)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $2`,
    [ORG, mode],
  );
}

describe('settleDeliveryFee — credito (revenue mode)', () => {
  it('adds the fee to the credito originalAmount and records a charge movement', async () => {
    const { settleDeliveryFee } = await import('@/features/delivery/settlement');

    const saleId = await seedSale();
    const deliveryOrderId = await seedDeliveryOrder();
    const creditoId = await seedCredito(saleId, '50000.00');
    await setFeeMode('revenue');

    await settleDeliveryFee({
      organizationId: ORG,
      deliveryOrderId,
      saleId,
      posTokenId: null,
      paymentType: 'Crédito',
      feeAmount: 5000,
      actorId: 'courier-1',
    });

    const [credito] = await pg.query<{ original_amount: string }>(
      `SELECT original_amount FROM creditos WHERE id = $1`,
      [creditoId],
    ).then(r => r.rows);

    expect(credito?.original_amount).toBe('55000.00');

    const movements = await pg.query<{ type: string; amount: string; note: string }>(
      `SELECT type, amount, note FROM credito_movements WHERE credito_id = $1`,
      [creditoId],
    ).then(r => r.rows);

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: 'charge',
      amount: '5000.00',
      note: 'Envío domicilio',
    });
  });

  it('is idempotent — running it twice only bumps originalAmount and inserts the charge once', async () => {
    const { settleDeliveryFee } = await import('@/features/delivery/settlement');

    const saleId = await seedSale();
    const deliveryOrderId = await seedDeliveryOrder();
    const creditoId = await seedCredito(saleId, '50000.00');
    await setFeeMode('revenue');

    const args = {
      organizationId: ORG,
      deliveryOrderId,
      saleId,
      posTokenId: null,
      paymentType: 'Crédito',
      feeAmount: 5000,
      actorId: 'courier-1',
    };

    await settleDeliveryFee(args);
    await settleDeliveryFee(args);

    const [credito] = await pg.query<{ original_amount: string }>(
      `SELECT original_amount FROM creditos WHERE id = $1`,
      [creditoId],
    ).then(r => r.rows);

    expect(credito?.original_amount).toBe('55000.00');

    const movements = await pg.query<{ id: string }>(
      `SELECT id FROM credito_movements WHERE credito_id = $1 AND type = 'charge' AND note = 'Envío domicilio'`,
      [creditoId],
    ).then(r => r.rows);

    expect(movements).toHaveLength(1);
  });

  it('no-ops when no credito exists for the sale (credito method, no credito row)', async () => {
    const { settleDeliveryFee } = await import('@/features/delivery/settlement');

    const saleId = await seedSale();
    const deliveryOrderId = await seedDeliveryOrder();
    await setFeeMode('revenue');

    await expect(settleDeliveryFee({
      organizationId: ORG,
      deliveryOrderId,
      saleId,
      posTokenId: null,
      paymentType: 'Crédito',
      feeAmount: 5000,
      actorId: 'courier-1',
    })).resolves.toBeUndefined();

    const movements = await pg.query(
      `SELECT id FROM credito_movements`,
    ).then(r => r.rows);

    expect(movements).toHaveLength(0);
  });
});

describe('settleDeliveryFee — cash (revenue mode, unchanged)', () => {
  it('still books the cash deposit and does not touch any credito', async () => {
    const { settleDeliveryFee } = await import('@/features/delivery/settlement');

    const saleId = await seedSale();
    const deliveryOrderId = await seedDeliveryOrder();
    const creditoId = await seedCredito(saleId, '50000.00');
    const sessionId = await openCashSession();
    await setFeeMode('revenue');

    await settleDeliveryFee({
      organizationId: ORG,
      deliveryOrderId,
      saleId,
      posTokenId: null,
      paymentType: 'Efectivo',
      feeAmount: 5000,
      actorId: 'courier-1',
    });

    const deposits = await pg.query<{ amount: string; session_id: string }>(
      `SELECT amount, session_id FROM cash_movements WHERE sale_id = $1 AND type = 'deposit'`,
      [saleId],
    ).then(r => r.rows);

    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({ amount: '5000.00', session_id: sessionId });

    const [credito] = await pg.query<{ original_amount: string }>(
      `SELECT original_amount FROM creditos WHERE id = $1`,
      [creditoId],
    ).then(r => r.rows);

    expect(credito?.original_amount).toBe('50000.00');

    const movements = await pg.query(`SELECT id FROM credito_movements`).then(r => r.rows);

    expect(movements).toHaveLength(0);
  });
});

describe('settleDeliveryFee — courier_tip mode wins over credito', () => {
  it('records the tip note and does not touch the credito', async () => {
    const { settleDeliveryFee } = await import('@/features/delivery/settlement');

    const saleId = await seedSale();
    const deliveryOrderId = await seedDeliveryOrder();
    const creditoId = await seedCredito(saleId, '50000.00');
    await setFeeMode('courier_tip');

    await settleDeliveryFee({
      organizationId: ORG,
      deliveryOrderId,
      saleId,
      posTokenId: null,
      paymentType: 'Crédito',
      feeAmount: 5000,
      actorId: 'courier-1',
    });

    const events = await pg.query<{ note: string }>(
      `SELECT note FROM delivery_events WHERE delivery_order_id = $1 AND type = 'note'`,
      [deliveryOrderId],
    ).then(r => r.rows);

    expect(events).toHaveLength(1);
    expect(events[0]?.note).toContain('Propina domiciliario');

    const [credito] = await pg.query<{ original_amount: string }>(
      `SELECT original_amount FROM creditos WHERE id = $1`,
      [creditoId],
    ).then(r => r.rows);

    expect(credito?.original_amount).toBe('50000.00');

    const movements = await pg.query(`SELECT id FROM credito_movements`).then(r => r.rows);

    expect(movements).toHaveLength(0);
  });
});
