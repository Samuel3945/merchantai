/**
 * PR3 — CREDITO customer capture tests (action layer)
 *
 * Strict TDD: RED tests written before the implementation.
 * These tests verify that resolveTransfer('receivable') now:
 *   1. Requires customer capture input (name + contact)
 *   2. Calls findOrCreateCustomer to get/create a real customers row
 *   3. Creates the credito with customer_id NOT null
 *   4. Does NOT rely on parseClient(sale.notes)
 *
 * Scenarios covered:
 *   S-05: CREDITO creates real customer + links (new customer, contact provided)
 *   S-05b: CREDITO dedup — same whatsapp reuses existing customer
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Hoisted state ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgRole: 'org:admin' as string,
  orgId: 'org-credito-test',
  userId: 'user_test',
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
    orgRole: h.orgRole,
  })),
  currentUser: vi.fn(async () => ({ fullName: 'Test User' })),
}));

vi.mock('@/libs/panel-session', () => ({
  requirePanelModule: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
  })),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// ── PGLite schema ─────────────────────────────────────────────────────────────

const SETUP_SQL = `
  CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved');
  CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability');
  CREATE TYPE "credito_status" AS ENUM('pending', 'paid', 'written_off');
  CREATE TYPE "credito_movement_type" AS ENUM('charge', 'payment', 'extension', 'writeoff', 'adjustment');
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'credito_payment');

  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    document_id text,
    whatsapp text,
    email text,
    address text,
    notes text,
    marketing_opt_in boolean DEFAULT true NOT NULL,
    total_spent numeric(14, 2) DEFAULT '0' NOT NULL,
    last_purchase_at timestamp,
    created_by text,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX customers_org_whatsapp_unique_idx
    ON customers (organization_id, whatsapp)
    WHERE whatsapp IS NOT NULL AND deleted = false;

  CREATE UNIQUE INDEX customers_org_document_unique_idx
    ON customers (organization_id, document_id)
    WHERE document_id IS NOT NULL AND deleted = false;

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
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
    opened_by_actor_id text,
    closed_by_actor_id text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text,
    client_session_id uuid,
    caja_id uuid
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

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    notes text
  );

  CREATE TABLE sale_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    bills_paid jsonb,
    change_given numeric(10, 2) DEFAULT '0' NOT NULL,
    reference text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE creditos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
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

  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid REFERENCES sale_payments(id) ON DELETE CASCADE,
    pos_token_id uuid,
    cash_session_id uuid,
    method text NOT NULL,
    expected_amount numeric(12, 2) NOT NULL,
    arrived_amount numeric(12, 2),
    reference text,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    reconciled_by text,
    reconciled_at timestamp,
    note text,
    resolution_type "transfer_resolution_type",
    resolved_by text,
    resolved_at timestamp,
    resolution_credito_id uuid REFERENCES creditos(id) ON DELETE SET NULL,
    claim_open boolean DEFAULT false NOT NULL,
    recovery_of_id uuid,
    remainder_reconciliation_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;
`;

const ORG = 'org-credito-test';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;
let pg: PGlite;

/**
 * Seeds: sale → sale_payment → transfer_reconciliation row in not_arrived status.
 * Returns the reconciliation id.
 */
async function seedReconWithSale(): Promise<{
  reconId: string;
  saleId: string;
  salePaymentId: string;
}> {
  counter++;
  const saleId = UUID(counter * 10);
  const salePaymentId = UUID(counter * 10 + 1);
  const reconId = UUID(counter * 10 + 2);

  await pg.query(
    `INSERT INTO sales (id, organization_id, notes) VALUES ($1, $2, $3)`,
    [saleId, ORG, null],
  );

  await pg.query(
    `INSERT INTO sale_payments (id, sale_id, method, amount)
     VALUES ($1, $2, 'Transferencia', '100.00')`,
    [salePaymentId, saleId],
  );

  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, sale_payment_id, method, expected_amount, status)
     VALUES ($1, $2, $3, 'Transferencia', '100.00', 'not_arrived')`,
    [reconId, ORG, salePaymentId],
  );

  return { reconId, saleId, salePaymentId };
}

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  // Clean between tests — order matters for FK constraints
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM credito_movements');
  await pg.exec('DELETE FROM creditos');
  await pg.exec('DELETE FROM sale_payments');
  await pg.exec('DELETE FROM sales');
  await pg.exec('DELETE FROM customers');
  counter = 0;
  h.orgRole = 'org:admin';
});

// ── S-05: CREDITO creates a real customer row ───────────────────────────────────

describe('S-05: CREDITO resolution — customer capture and link', () => {
  it('creates a customers row when resolving as receivable with captured contact', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: 'Ana García',
      whatsapp: '3001234567',
    });

    expect(result.ok).toBe(true);

    // A customers row must exist
    const customers = await pg.query<{ id: string; name: string }>(
      `SELECT id, name FROM customers WHERE organization_id = $1`,
      [ORG],
    );

    expect(customers.rows).toHaveLength(1);
    expect(customers.rows[0]?.name).toBe('Ana García');
  });

  it('creates the credito with customer_id NOT null', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: 'Ana García',
      whatsapp: '3001234567',
    });

    expect(result.ok).toBe(true);

    // The credito must have customer_id set
    const creditos = await pg.query<{ customer_id: string | null }>(
      `SELECT customer_id FROM creditos WHERE organization_id = $1`,
      [ORG],
    );

    expect(creditos.rows).toHaveLength(1);
    expect(creditos.rows[0]?.customer_id).not.toBeNull();

    // And customer_id must match the created customer
    const customers = await pg.query<{ id: string }>(
      `SELECT id FROM customers WHERE organization_id = $1`,
      [ORG],
    );

    expect(creditos.rows[0]?.customer_id).toBe(customers.rows[0]?.id);
  });

  it('sets the reconciliation status to resolved with resolutionType receivable', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: 'Ana García',
      whatsapp: '3001234567',
    });

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [reconId],
    );

    expect(rows.rows[0]?.status).toBe('resolved');
    expect(rows.rows[0]?.resolution_type).toBe('receivable');
  });

  it('falls back to a legacy credito with null customer_id when no customerName is given', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    // Backward compatibility: the current panel button calls without customer
    // data. It must still resolve (no throw) and create a legacy credito whose
    // customer_id is null until the View B capture UI is wired.
    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: '',
    });

    expect(result.ok).toBe(true);

    const creditos = await pg.query<{ customer_id: string | null }>(
      `SELECT customer_id FROM creditos WHERE organization_id = $1`,
      [ORG],
    );

    expect(creditos.rows).toHaveLength(1);
    expect(creditos.rows[0]?.customer_id).toBeNull();
  });
});

// ── S-05b: CREDITO dedup — same whatsapp reuses existing customer ───────────────

describe('S-05b: CREDITO dedup — second CREDITO with same whatsapp reuses customer', () => {
  it('reuses an existing customer when the same whatsapp is provided', async () => {
    // Pre-create a customer
    const existingCustomerResult = await pg.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, whatsapp, deleted)
       VALUES ($1, 'Ana García', '3001234567', false)
       RETURNING id`,
      [ORG],
    );
    const existingCustomerId = existingCustomerResult.rows[0]?.id;

    expect(existingCustomerId).toBeTruthy();

    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: 'Ana García',
      whatsapp: '3001234567',
    });

    expect(result.ok).toBe(true);

    // Only one customer row should exist (the pre-existing one)
    const customers = await pg.query<{ id: string }>(
      `SELECT id FROM customers WHERE organization_id = $1`,
      [ORG],
    );

    expect(customers.rows).toHaveLength(1);
    expect(customers.rows[0]?.id).toBe(existingCustomerId);

    // The credito must link to the existing customer
    const creditos = await pg.query<{ customer_id: string }>(
      `SELECT customer_id FROM creditos WHERE organization_id = $1`,
      [ORG],
    );

    expect(creditos.rows[0]?.customer_id).toBe(existingCustomerId);
  });

  it('creates a separate customer when whatsapp is different', async () => {
    await pg.query(
      `INSERT INTO customers (organization_id, name, whatsapp, deleted)
       VALUES ($1, 'Ana García', '3001111111', false)`,
      [ORG],
    );

    const { resolveTransfer } = await import('./transfer-reconciliation');
    const { reconId } = await seedReconWithSale();

    const result = await resolveTransfer(reconId, 'receivable', {
      customerName: 'Ana García',
      whatsapp: '3002222222',
    });

    expect(result.ok).toBe(true);

    const customers = await pg.query(
      `SELECT id FROM customers WHERE organization_id = $1`,
      [ORG],
    );

    expect(customers.rows).toHaveLength(2);
  });
});
