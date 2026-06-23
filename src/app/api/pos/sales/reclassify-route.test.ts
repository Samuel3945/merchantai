/**
 * POS "error de carga" reclassify endpoint — route-level wiring.
 *
 * Validates the device contract around POST /api/pos/sales/reclassify:
 *   - happy path: a current-shift sale's split is corrected (200, split moved)
 *   - guard wiring: a past-shift sale is rejected (400)
 *   - no open caja → 400
 *   - missing fields → 400
 *
 * The reclassification math itself is covered by payment-reclassification.test.
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { salePaymentsSchema } from '@/models/Schema';
import { POST } from './reclassify/route';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/libs/pos-auth', () => ({
  requirePosAuth: vi.fn(async () => ({ ctx: h.authCtx, errorResponse: null })),
}));
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
}));

const ORG = 'org_reclassify_route';
const TOKEN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SALE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAYMENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification');
  CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending','confirmed','not_arrived','mismatch','resolved');
  CREATE TYPE "transfer_resolution_type" AS ENUM('receivable','loss','cashier_liability');

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
    client_session_id uuid
  );

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
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
    resolution_fiado_id uuid,
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

let pg: PGlite;

function reclassifyRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/sales/reclassify', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function seedOpenSession(): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, status)
     VALUES ($1, $2, $3, 'Cajero', 'open')`,
    [SESSION_ID, ORG, TOKEN],
  );
}

// A sale created AFTER the session opens (current shift) with a single cash payment.
async function seedCashSale(): Promise<void> {
  await pg.query(
    `INSERT INTO sales (id, organization_id, pos_token_id) VALUES ($1, $2, $3)`,
    [SALE_ID, ORG, TOKEN],
  );
  await pg.query(
    `INSERT INTO sale_payments (id, sale_id, method, amount) VALUES ($1, $2, 'Efectivo', '50.00')`,
    [PAYMENT_ID, SALE_ID],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM sale_payments');
  await pg.exec('DELETE FROM sales');
  await pg.exec('DELETE FROM cash_sessions');
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Cajero',
    source: 'token',
    tokenId: TOKEN,
    cashierId: null,
    canConfirmTransfers: true,
  };
  vi.clearAllMocks();
});

describe('POST /api/pos/sales/reclassify', () => {
  it('corrects the split of a current-shift sale (200)', async () => {
    await seedOpenSession();
    await seedCashSale();

    const res = await POST(
      reclassifyRequest({
        sale_payment_id: PAYMENT_ID,
        to_method: 'Transferencia',
        amount: 20,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const split = await h.db
      .select({
        method: salePaymentsSchema.method,
        amount: salePaymentsSchema.amount,
      })
      .from(salePaymentsSchema)
      .where(eq(salePaymentsSchema.saleId, SALE_ID));
    const byMethod = Object.fromEntries(split.map(p => [p.method, p.amount]));

    expect(byMethod.Efectivo).toBe('30.00');
    expect(byMethod.Transferencia).toBe('20.00');
  });

  it('rejects a sale from a past shift (400)', async () => {
    await seedOpenSession();
    await seedCashSale();
    // Push the sale before the session opened.
    await pg.query(
      `UPDATE sales SET created_at = '2000-01-01 00:00:00' WHERE id = $1`,
      [SALE_ID],
    );

    const res = await POST(
      reclassifyRequest({
        sale_payment_id: PAYMENT_ID,
        to_method: 'Transferencia',
        amount: 20,
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/turno actual/i);
  });

  it('rejects when there is no open caja (400)', async () => {
    await seedCashSale(); // sale exists, but no open session

    const res = await POST(
      reclassifyRequest({
        sale_payment_id: PAYMENT_ID,
        to_method: 'Transferencia',
        amount: 20,
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/caja abierta/i);
  });

  it('rejects a missing sale_payment_id (400)', async () => {
    await seedOpenSession();

    const res = await POST(
      reclassifyRequest({ to_method: 'Transferencia', amount: 20 }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sale_payment_id/i);
  });

  it('rejects a missing to_method (400)', async () => {
    await seedOpenSession();
    await seedCashSale();

    const res = await POST(
      reclassifyRequest({ sale_payment_id: PAYMENT_ID, amount: 20 }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/to_method/i);
  });
});
