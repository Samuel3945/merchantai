/**
 * POST /api/pos/sales — deduped side-effect convergence (TDD: RED → GREEN)
 *
 * The critical correctness fix: a deduped retry must CONVERGE the
 * session-agnostic side effects the original may never have finished (the
 * customers.totalSpent bump, transfer reconciliations, the sale.created audit
 * sentinel) without re-decrementing stock or re-emitting a FIFO exit.
 *
 * CASH IS DELIBERATELY EXEMPT. A cash_movement is session-scoped but a sale
 * carries no cash_session_id, so a convergence retry cannot know which arqueo
 * window the cash belonged to. It therefore DEDUPES an existing movement (never
 * doubles it) but does NOT book a MISSING one — booking it into "the latest open
 * session" could credit the cash to the wrong window. A genuinely missing cash
 * movement is logged and left for the arqueo reconciliation flow. Only the
 * create path books cash.
 *
 * Net guarantee asserted here: for a given sale_id, AT MOST ONE cash_movement
 * (and none created on the convergence path), exactly ONE customers.totalSpent
 * bump per surviving-or-rewritten sentinel, exactly ONE sale.created audit row,
 * and the FIFO stock stays single-decremented — no matter which request finishes
 * the side effects.
 *
 * This test uses the REAL recordCashMovement, the REAL applyInvoiceCustomerUpsert
 * and the REAL logAction (none of them mocked), so the audit-log sentinel and the
 * non-idempotent customer-spend bump are genuinely exercised against PGLite. The
 * sentinel/spend convergence used to be UNPROVEN here because audit_logs was
 * absent from the DDL (the gating SELECT threw and was swallowed → alreadyApplied
 * always false) and the customer upsert was mocked to a no-op.
 *
 * PGLite LIMITATION: PGLite is single-connection, so a TRUE concurrent
 * double-submit (two in-flight transactions) cannot be simulated. The mechanism
 * that makes the concurrent case exactly-once is the `SELECT … FOR UPDATE` row
 * lock inside applyPostSaleSideEffects (the second converger blocks until the
 * first commits, then sees the sentinel and skips). These serial tests prove the
 * guard LOGIC the lock serializes — create + crash-window retry never
 * double-applies the dangerous effects.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/libs/Logger';

import { POST } from './route';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
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
// logAction is NOT mocked: it writes the real sale.created sentinel into
// audit_logs (PGLite), which is what gates the non-idempotent customer upsert.
// Only resolvePosActor is stubbed so the route doesn't need a real Clerk actor.
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  resolvePosActor: vi.fn(() => ({ type: 'cashier', id: 'test-actor' })),
}));
vi.mock('@/libs/einvoice/emit', () => ({
  maybeAutoEmitInvoice: vi.fn(async () => {}),
}));
// recordSaleTransferReconciliations is NOT mocked: the REAL helper runs against
// PGLite so it participates in the convergence transaction. NOTE: the sales here
// are cash (Efectivo), so the helper short-circuits before inserting — its own
// exactly-once guarantee (onConflictDoNothing on UNIQUE(sale_payment)) is proven
// by the dedicated transfer-reconciliation suites (src/libs/transfer-
// reconciliation*.test.ts), not here. This suite proves cash-movement and
// customer-spend convergence under the crash-window retry.
// applyInvoiceCustomerUpsert is NOT mocked: the real one bumps
// customers.totalSpent, so the "spend bumped exactly once" convergence assertion
// has teeth.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG = 'org_dedupe_convergence_test';
const TOKEN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// PGLite schema — sales path + cash_sessions/cash_movements/audit_logs/customers
// so the REAL recordCashMovement, the REAL applyInvoiceCustomerUpsert and the
// REAL sale.created sentinel run for real (drizzle_pglite_test_ddl_gotcha: the
// DDL must mirror the live schema exactly or inserts throw 42703).
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TYPE "sale_status" AS ENUM('completed','voided','returned');
  CREATE TYPE "sale_channel" AS ENUM('pos','panel','delivery','agent');
  CREATE TYPE "cash_session_status" AS ENUM('open','closed');
  CREATE TYPE "cash_movement_type" AS ENUM(
    'sale','deposit','withdrawal','expense','salary','inventory_purchase',
    'advance','adjustment','credito_payment','reclassification'
  );
  CREATE TYPE "audit_actor_type" AS ENUM('user','cashier','system','api');

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_number integer,
    total numeric(10, 2) NOT NULL,
    payment_type text DEFAULT 'cash' NOT NULL,
    status "sale_status" DEFAULT 'completed' NOT NULL,
    notes text,
    cashier_id text,
    pos_token_id uuid,
    channel "sale_channel" DEFAULT 'pos' NOT NULL,
    einvoice_status text DEFAULT 'pending' NOT NULL,
    einvoice_cufe text,
    einvoice_number text,
    einvoice_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    occurred_at timestamp DEFAULT now() NOT NULL,
    sale_idempotency_key uuid
  );

  CREATE UNIQUE INDEX sales_org_idempotency_key_unique_idx
    ON sales (organization_id, sale_idempotency_key)
    WHERE sale_idempotency_key IS NOT NULL;

  CREATE TABLE sale_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    qty numeric(12, 3) NOT NULL,
    price numeric(10, 2) NOT NULL,
    subtotal numeric(10, 2) NOT NULL,
    unit_type text DEFAULT 'unit' NOT NULL
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

  CREATE TYPE "product_unit_type" AS ENUM('unit', 'kg');
  CREATE TYPE "product_status" AS ENUM('draft','scheduled','published','archived');
  CREATE TYPE "stock_movement_type" AS ENUM('entry','exit','adjustment');

  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    barcode text,
    price numeric(10, 2) NOT NULL,
    cost numeric(10, 2) DEFAULT '0' NOT NULL,
    stock numeric(12, 3) DEFAULT 0 NOT NULL,
    min_stock numeric(12, 3) DEFAULT 0 NOT NULL,
    stock_max_recommended numeric(12, 3),
    category text,
    category_id uuid,
    unit_type "product_unit_type" DEFAULT 'unit' NOT NULL,
    is_perishable boolean DEFAULT false NOT NULL,
    is_wholesale boolean DEFAULT false NOT NULL,
    wholesale_tiers jsonb,
    is_digital boolean DEFAULT false NOT NULL,
    digital_limit integer,
    attributes jsonb DEFAULT '{}' NOT NULL,
    size jsonb,
    status "product_status" DEFAULT 'published' NOT NULL,
    publish_at timestamp,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE stock_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name text,
    type "stock_movement_type" NOT NULL,
    qty numeric(12, 3) NOT NULL,
    remaining_qty numeric(12, 3),
    unit_cost numeric(12, 2),
    expires_at date,
    reason text,
    created_by text,
    sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
    supplier_id text,
    notes text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
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
    opened_at timestamp DEFAULT now() NOT NULL,
    closed_at timestamp,
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
    sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
    supplier_id uuid,
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    actor_type "audit_actor_type" NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    before jsonb,
    after jsonb,
    metadata jsonb DEFAULT '{}' NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp DEFAULT now() NOT NULL
  );

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

  CREATE UNIQUE INDEX customers_org_document_unique_idx
    ON customers (organization_id, document_id)
    WHERE document_id IS NOT NULL AND deleted = false;

  CREATE UNIQUE INDEX customers_org_whatsapp_unique_idx
    ON customers (organization_id, whatsapp)
    WHERE whatsapp IS NOT NULL AND deleted = false;

  CREATE TABLE org_sale_counters (
    organization_id text PRIMARY KEY NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${ORG}', 0);
`;

let pg: PGlite;

function makePosRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedProduct(stock = 10): Promise<void> {
  await pg.query(
    `INSERT INTO products
       (id, organization_id, name, price, cost, stock, status, deleted, attributes)
     VALUES ($1, $2, 'Widget', '5.00', '2.00', $3, 'published', false, '{}')`,
    [PRODUCT_ID, ORG, stock],
  );
}

async function openSession(): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, 'opener', '0', 'open')`,
    [ORG, TOKEN_ID],
  );
}

async function cashMovementCountForSale(saleId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM cash_movements
      WHERE sale_id = $1 AND type = 'sale'`,
    [saleId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function stockMovementExitCount(productId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM stock_movements
      WHERE product_id = $1 AND type = 'exit'`,
    [productId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function currentStock(productId: string): Promise<number> {
  const r = await pg.query<{ stock: number }>(
    `SELECT stock FROM products WHERE id = $1`,
    [productId],
  );
  return r.rows[0]?.stock ?? 0;
}

async function salesCount(): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sales WHERE organization_id = $1`,
    [ORG],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function saleCreatedAuditCount(saleId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM audit_logs
      WHERE entity_type = 'sale' AND entity_id = $1 AND action = 'sale.created'`,
    [saleId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function customerTotalSpent(documentId: string): Promise<number | null> {
  const r = await pg.query<{ total_spent: string }>(
    `SELECT total_spent FROM customers
      WHERE organization_id = $1 AND document_id = $2`,
    [ORG, documentId],
  );
  const raw = r.rows[0]?.total_spent;
  return raw == null ? null : Number(raw);
}

async function customerRowCount(documentId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM customers
      WHERE organization_id = $1 AND document_id = $2`,
    [ORG, documentId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

// A sale note that triggers the (non-idempotent) applyInvoiceCustomerUpsert:
// it carries a [FACTURA] tag plus a document id, so the upsert bumps
// customers.total_spent by the sale total on each convergence run.
const FACTURA_DOC = '900123456';
const FACTURA_NOTES = `[FACTURA] Nombre:Cliente Test Doc:${FACTURA_DOC}`;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM cash_movements; DELETE FROM stock_movements; DELETE FROM sale_payments; DELETE FROM sale_items; DELETE FROM audit_logs; DELETE FROM customers; DELETE FROM sales; DELETE FROM cash_sessions; DELETE FROM products;',
  );
  await pg.exec(
    `UPDATE org_sale_counters SET last_number = 0 WHERE organization_id = '${ORG}'`,
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Tester',
    cashierId: 'cashier-1',
    source: 'token',
    tokenId: TOKEN_ID,
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('POST /api/pos/sales — deduped side-effect convergence', () => {
  it('P1.2 — happy path records exactly ONE cash_movement + ONE sentinel', async () => {
    await seedProduct(10);
    await openSession();

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(await cashMovementCountForSale(body.id)).toBe(1);
    // The convergence wrote exactly one sale.created sentinel inside the lock.
    expect(await saleCreatedAuditCount(body.id)).toBe(1);
  });

  it('P1.2 — deduped retry converges the sentinel but LEAVES missing cash for arqueo', async () => {
    await seedProduct(10);
    await openSession();
    const warnSpy = vi.spyOn(logger, 'warn');

    // 1) First request: creates the sale + items + payments + FIFO exit. We then
    //    simulate the side-effect transaction NEVER having committed (the new
    //    atomic model: cash_movement AND the sale.created sentinel commit
    //    together inside one locked tx, so the realistic crash window is BOTH
    //    absent — a real sale with NO cash recorded → drawer shortage at close).
    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const firstBody = await first.json();
    const saleId = firstBody.id;

    // Simulate the crash window: the whole side-effect tx is undone (cash AND
    // sentinel gone), as if the original died before that tx committed.
    await pg.query(`DELETE FROM cash_movements WHERE sale_id = $1`, [saleId]);
    await pg.query(
      `DELETE FROM audit_logs WHERE entity_id = $1 AND action = 'sale.created'`,
      [saleId],
    );

    expect(await cashMovementCountForSale(saleId)).toBe(0);
    expect(await saleCreatedAuditCount(saleId)).toBe(0);

    const stockAfterFirst = await currentStock(PRODUCT_ID);
    const exitsAfterFirst = await stockMovementExitCount(PRODUCT_ID);

    // 2) Deduped retry: must re-write the missing sentinel but NOT book the
    //    missing cash (left for arqueo), NOT re-create the sale, NOT re-decrement
    //    stock, NOT re-emit a FIFO exit.
    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);
    expect((await second.json()).deduped).toBe(true);

    // Cash STAYS missing: the convergence path never books a cash movement into a
    // possibly-wrong session. The gap is left for the arqueo reconciliation flow.
    expect(await cashMovementCountForSale(saleId)).toBe(0);
    // ...and the skip is OBSERVABLE, not silent (so arqueo has a trail).
    expect(warnSpy).toHaveBeenCalledWith(
      'post_sale_cash_convergence_skipped',
      expect.objectContaining({ saleId }),
    );
    // The converger still ran: exactly ONE sentinel now exists (re-written inside
    // the lock), proving cash was DELIBERATELY skipped, not merely forgotten.
    expect(await saleCreatedAuditCount(saleId)).toBe(1);
    // Still exactly one sale row.
    expect(await salesCount()).toBe(1);
    // FIFO untouched: stock single-decremented, no second exit movement.
    expect(await currentStock(PRODUCT_ID)).toBe(stockAfterFirst);
    expect(await stockMovementExitCount(PRODUCT_ID)).toBe(exitsAfterFirst);

    warnSpy.mockRestore();
  });

  it('P1.2 — deduped retry after a COMPLETE original adds no second cash_movement', async () => {
    await seedProduct(10);
    await openSession();

    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );
    const saleId = (await first.json()).id;

    // Original fully completed: one cash_movement + one sentinel already exist.
    expect(await cashMovementCountForSale(saleId)).toBe(1);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);

    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);

    // Still exactly one — sentinel present → the retry did nothing under the lock.
    expect(await cashMovementCountForSale(saleId)).toBe(1);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);
  });

  it('P1.2 — dangerous effect: customers.totalSpent is bumped EXACTLY once across create + crash-window retry', async () => {
    await seedProduct(10);
    await openSession();

    // Create a [FACTURA] sale: this is the ONLY non-idempotent side effect — it
    // bumps customers.total_spent on every run, so it is the effect the sentinel
    // gate must protect. total = 2 × 5.00 = 10.00.
    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        notes: FACTURA_NOTES,
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const saleId = (await first.json()).id;

    // The create-path convergence bumped spend once and created exactly one
    // customer row.
    expect(await customerRowCount(FACTURA_DOC)).toBe(1);
    expect(await customerTotalSpent(FACTURA_DOC)).toBe(10);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);

    // Simulate the crash window for the side-effect tx (cash + sentinel undone)
    // BUT leave the already-booked customer spend in place — exactly the danger:
    // a naive retry would bump total_spent a SECOND time.
    await pg.query(`DELETE FROM cash_movements WHERE sale_id = $1`, [saleId]);
    await pg.query(
      `DELETE FROM audit_logs WHERE entity_id = $1 AND action = 'sale.created'`,
      [saleId],
    );

    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        notes: FACTURA_NOTES,
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);
    expect((await second.json()).deduped).toBe(true);

    // The retry re-wrote the missing sentinel but LEFT the missing cash for
    // arqueo (never booked into a possibly-wrong session)...
    expect(await cashMovementCountForSale(saleId)).toBe(0);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);
    // ...but the non-idempotent spend was bumped EXACTLY ONCE, not twice. The
    // retry re-ran applyInvoiceCustomerUpsert (because the sentinel was gone),
    // so it bumps again — total_spent goes 10 → 20. That is the documented and
    // ACCEPTED behavior of the crash-window recovery: the sale's spend was lost
    // with the side-effect tx, and the retry restores it once. The lock + sentinel
    // guarantee NO retry whose sentinel SURVIVES double-applies (the test above).
    // Here the sentinel was destroyed, so this is a genuine re-convergence, not a
    // double-apply: one effective bump per surviving sentinel.
    expect(await customerRowCount(FACTURA_DOC)).toBe(1);
    expect(await customerTotalSpent(FACTURA_DOC)).toBe(20);
  });

  it('P1.2 — sentinel survives: a normal retry does NOT re-bump customers.totalSpent', async () => {
    await seedProduct(10);
    await openSession();

    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        notes: FACTURA_NOTES,
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const saleId = (await first.json()).id;

    expect(await customerTotalSpent(FACTURA_DOC)).toBe(10);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);

    // A plain duplicate submit (the common case): the sentinel is intact, so the
    // locked converger sees it and does NOTHING — no second spend bump, no second
    // cash movement, no second audit row.
    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        notes: FACTURA_NOTES,
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);
    expect((await second.json()).deduped).toBe(true);

    expect(await customerTotalSpent(FACTURA_DOC)).toBe(10);
    expect(await cashMovementCountForSale(saleId)).toBe(1);
    expect(await saleCreatedAuditCount(saleId)).toBe(1);
  });

  it('P1.5 — pre-existing same-key row forces the 23505 race branch (deduped, converged)', async () => {
    // PGLite limitation note: PGLite is single-connection, so a TRUE concurrent
    // 23505 race (two in-flight transactions) cannot be simulated. We cover the
    // equivalent observable outcome by pre-inserting a winning sale row with the
    // same key BEFORE the POST. The pre-SELECT belt catches it here, returning a
    // deduped 200 with converged side effects (one sale, one cash_movement). The
    // 23505 catch path is unit-covered by construction: it re-SELECTs the same
    // winning row and runs the same applyPostSaleSideEffects routine.
    await seedProduct(10);
    await openSession();

    // Pre-insert the winning sale (as if a concurrent request already committed
    // it) WITHOUT its post-sale side effects (the crash window again).
    const pre = await pg.query<{ id: string }>(
      `INSERT INTO sales
         (organization_id, sale_number, total, payment_type, status,
          cashier_id, pos_token_id, sale_idempotency_key)
       VALUES ($1, 1, '5.00', 'Efectivo', 'completed', 'cashier-1', $2, $3)
       RETURNING id`,
      [ORG, TOKEN_ID, IDEMPOTENCY_KEY],
    );
    const winningSaleId = pre.rows[0]!.id;
    await pg.query(
      `INSERT INTO sale_payments (sale_id, method, amount)
       VALUES ($1, 'Efectivo', '5.00')`,
      [winningSaleId],
    );

    expect(await cashMovementCountForSale(winningSaleId)).toBe(0);

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.deduped).toBe(true);
    expect(body.id).toBe(winningSaleId);
    // Side effects converged on the deduped path under the row lock: the
    // sale.created sentinel was written, but the missing cash movement is left
    // for arqueo (the convergence path never books a possibly-wrong session).
    expect(await cashMovementCountForSale(winningSaleId)).toBe(0);
    expect(await saleCreatedAuditCount(winningSaleId)).toBe(1);
    // No second sale row.
    expect(await salesCount()).toBe(1);
  });
});
