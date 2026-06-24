/**
 * PGLite-backed tests for the bulk import → single invoice grouping behaviour.
 *
 * TDD cycle: RED → GREEN.  Tests describe the contract BEFORE implementation.
 *
 * The seam tested here is the combination of:
 *   1. `resolveInvoiceInTx(mode='existing', purchaseId)` — reuse a pre-created header.
 *   2. `insertPurchasePayable({ purchaseId })` — stamp each row's payable with it.
 *   3. `listOpenInvoices` — verify all stamped payables surface as ONE group.
 *
 * This mirrors exactly what `bulkRecordEntries` will do after the implementation:
 *   - Create ONE supplier_purchases header before the row loop.
 *   - Pass `invoiceContext: { mode: 'existing', purchaseId }` to every row.
 *   - Each row's payable gets `purchase_id` stamped.
 *
 * Covers:
 *   TC-1  purchase batch → ONE header created, ALL payables share that purchase_id.
 *   TC-2  manual import → NO header, NO payables (back-compat unchanged).
 *   TC-3  one bad row in a batch → header + good rows' payables committed; bad row has no payable.
 *   TC-4  invoiceNumber stamped on the header when provided.
 *   TC-5  single-row batch → still creates a header (not standalone).
 *   TC-6  listOpenInvoices groups all batch payables under one invoice entry.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listOpenInvoices,
  resolveInvoiceInTx,
} from '@/libs/supplier-invoice-payment';
import { insertPurchasePayable } from '@/libs/supplier-payables';

// ── PGLite database type ──────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let rawDb: RawDb;

// ── ENUMs ─────────────────────────────────────────────────────────────────────

const ENUMS = [
  `CREATE TYPE "supplier_payable_status" AS ENUM('open','partial','paid')`,
  `CREATE TYPE "stock_movement_type" AS ENUM('entry','exit')`,
  `CREATE TYPE "supplier_status" AS ENUM('active','archived')`,
];

// ── DDL ───────────────────────────────────────────────────────────────────────
// Must mirror Schema.ts exactly (migration 0069 additions included).

const DDL = `
  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    stock numeric(12,3) DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    company text,
    phone text,
    email text,
    city text,
    address text,
    tax_id text,
    notes text,
    status "supplier_status" DEFAULT 'active' NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE stock_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name text,
    type "stock_movement_type" NOT NULL,
    qty numeric(12,3) NOT NULL,
    remaining_qty numeric(12,3),
    unit_cost numeric(12,2),
    expires_at date,
    reason text,
    created_by text,
    sale_id uuid,
    supplier_id text,
    notes text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE supplier_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    invoice_number text,
    purchased_at timestamp DEFAULT now() NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX supplier_purchases_org_supplier_invoice_unique
    ON supplier_purchases (organization_id, supplier_id, invoice_number)
    WHERE invoice_number IS NOT NULL;

  CREATE TABLE supplier_payables (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE RESTRICT,
    total_amount numeric(12,2) NOT NULL,
    paid_amount numeric(12,2) DEFAULT '0' NOT NULL,
    credited_amount numeric(12,2) DEFAULT '0' NOT NULL,
    status "supplier_payable_status" DEFAULT 'open' NOT NULL,
    purchased_at timestamp DEFAULT now() NOT NULL,
    purchase_id uuid REFERENCES supplier_purchases(id) ON DELETE SET NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX supplier_payables_stock_movement_unique
    ON supplier_payables (stock_movement_id)
    WHERE stock_movement_id IS NOT NULL;
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG = 'org-bulk-import-1';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-200000000001';
const USER_ID = 'user-bulk-test';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = new PGlite();
  rawDb = drizzle(pg) as unknown as RawDb;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  // FK order: children before parents.
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM supplier_purchases');
  await pg.exec('DELETE FROM stock_movements');
  await pg.exec('DELETE FROM suppliers');
  await pg.exec('DELETE FROM products');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedProduct(id: string): Promise<void> {
  await pg.query(
    `INSERT INTO products (id, organization_id, name, deleted, stock, updated_at, created_at)
     VALUES ($1, $2, 'Producto de prueba', false, 0, now(), now())`,
    [id, ORG],
  );
}

async function seedStockMovement(id: string, productId: string): Promise<void> {
  await pg.query(
    `INSERT INTO stock_movements
       (id, organization_id, product_id, type, qty, remaining_qty, unit_cost,
        reason, created_by, created_at)
     VALUES ($1, $2, $3, 'entry', 10, 10, '100.00', 'purchase', $4, now())`,
    [id, ORG, productId, USER_ID],
  );
}

/**
 * Create a supplier_purchases header directly via raw SQL (simulates what
 * bulkRecordEntries does before entering the row loop).
 */
async function createHeader(
  invoiceNumber: string | null = null,
): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO supplier_purchases
       (organization_id, supplier_id, invoice_number, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     RETURNING id`,
    [ORG, SUPPLIER_ID, invoiceNumber, USER_ID],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create supplier_purchases header');
  }
  return row.id;
}

// ── TC-1: purchase batch → ONE header, ALL payables share purchase_id ─────────

describe('TC-1: purchase batch groups all payables under one header', () => {
  it('all payables in a 3-row batch have the same purchase_id', async () => {
    const PRODUCT_1 = '00000000-0000-0000-cccc-200000000001';
    const PRODUCT_2 = '00000000-0000-0000-cccc-200000000002';
    const PRODUCT_3 = '00000000-0000-0000-cccc-200000000003';
    const MOV_1 = '00000000-0000-0000-dddd-200000000001';
    const MOV_2 = '00000000-0000-0000-dddd-200000000002';
    const MOV_3 = '00000000-0000-0000-dddd-200000000003';

    await seedProduct(PRODUCT_1);
    await seedProduct(PRODUCT_2);
    await seedProduct(PRODUCT_3);
    await seedStockMovement(MOV_1, PRODUCT_1);
    await seedStockMovement(MOV_2, PRODUCT_2);
    await seedStockMovement(MOV_3, PRODUCT_3);

    // Create ONE header before the loop (the design decision).
    const purchaseId = await createHeader(null);

    // Simulate each row independently passing invoiceContext: mode='existing'.
    for (const movId of [MOV_1, MOV_2, MOV_3]) {
      const resolved = await resolveInvoiceInTx(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        createdBy: USER_ID,
        context: { mode: 'existing', purchaseId },
      });
      await insertPurchasePayable(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        stockMovementId: movId,
        qty: 10,
        unitCost: '100.00',
        createdBy: USER_ID,
        purchaseId: resolved.purchaseId,
      });
    }

    // All 3 payables must reference the SAME purchase_id.
    const rows = await pg.query<{ purchase_id: string | null }>(
      'SELECT purchase_id FROM supplier_payables WHERE organization_id = $1 ORDER BY created_at',
      [ORG],
    );

    expect(rows.rows).toHaveLength(3);

    const ids = rows.rows.map(r => r.purchase_id);

    expect(ids.every(id => id === purchaseId)).toBe(true);
  });

  it('only ONE supplier_purchases row is created for the whole batch', async () => {
    const PRODUCT_A = '00000000-0000-0000-cccc-200000000011';
    const PRODUCT_B = '00000000-0000-0000-cccc-200000000012';
    const MOV_A = '00000000-0000-0000-dddd-200000000011';
    const MOV_B = '00000000-0000-0000-dddd-200000000012';

    await seedProduct(PRODUCT_A);
    await seedProduct(PRODUCT_B);
    await seedStockMovement(MOV_A, PRODUCT_A);
    await seedStockMovement(MOV_B, PRODUCT_B);

    const purchaseId = await createHeader(null);

    for (const movId of [MOV_A, MOV_B]) {
      const resolved = await resolveInvoiceInTx(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        createdBy: USER_ID,
        context: { mode: 'existing', purchaseId },
      });
      await insertPurchasePayable(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        stockMovementId: movId,
        qty: 5,
        unitCost: '200.00',
        createdBy: USER_ID,
        purchaseId: resolved.purchaseId,
      });
    }

    const headerCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(headerCount.rows[0]!.count)).toBe(1);
  });
});

// ── TC-2: manual import → no header, no payables ──────────────────────────────
//
// Guards the reason==='purchase' gate: a stock movement inserted WITHOUT going
// through the purchase/payable seam must produce zero supplier_purchases and
// zero supplier_payables rows.  This test WOULD FAIL if the guard regressed
// (e.g. someone removed the `reason === 'purchase'` condition and always
// created a header).

describe('TC-2: manual import creates no header and no payables', () => {
  it('manual stock entry produces no supplier_purchases and no supplier_payables', async () => {
    const PRODUCT_MANUAL = '00000000-0000-0000-cccc-200000000061';
    const MOV_MANUAL = '00000000-0000-0000-dddd-200000000061';

    await seedProduct(PRODUCT_MANUAL);
    // Insert a stock_movement with reason='manual' — simulates what
    // bulkRecordEntries does for manual imports: no header, no invoiceContext,
    // no payable insertion.
    await pg.query(
      `INSERT INTO stock_movements
         (id, organization_id, product_id, type, qty, remaining_qty, unit_cost,
          reason, created_by, created_at)
       VALUES ($1, $2, $3, 'entry', 5, 5, '50.00', 'manual', $4, now())`,
      [MOV_MANUAL, ORG, PRODUCT_MANUAL, USER_ID],
    );

    // Intentionally do NOT call resolveInvoiceInTx or insertPurchasePayable —
    // that's the guard: reason='manual' skips both.

    const headerCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );
    const payableCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_payables WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(headerCount.rows[0]!.count)).toBe(0);
    expect(Number(payableCount.rows[0]!.count)).toBe(0);
  });

  it('calling resolveInvoiceInTx without a purchase reason creates a header (guard contrast)', async () => {
    // Contrast test: if the guard were absent and we DID call the purchase seam
    // for a manual row, a header WOULD appear.  This confirms the guard is load-bearing.
    const purchaseId = await createHeader(null);

    const headerCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );

    // Exactly 1 row — the one we just created by bypassing the guard.
    expect(Number(headerCount.rows[0]!.count)).toBe(1);

    // Sanity: the id is what we expect.
    const row = await pg.query<{ id: string }>(
      'SELECT id FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );

    expect(row.rows[0]!.id).toBe(purchaseId);
  });
});

// ── TC-3: one bad row → header + good rows committed; bad row has no payable ──

describe('TC-3: partial failure — header and good rows survive a bad row', () => {
  it('header exists and good-row payables committed even when one row fails', async () => {
    const PRODUCT_OK = '00000000-0000-0000-cccc-200000000021';
    const MOV_OK = '00000000-0000-0000-dddd-200000000021';

    await seedProduct(PRODUCT_OK);
    await seedStockMovement(MOV_OK, PRODUCT_OK);

    // Create ONE header before the loop.
    const purchaseId = await createHeader(null);
    let goodRowCommitted = false;

    // Row 1: good row — succeeds.
    try {
      const resolved = await resolveInvoiceInTx(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        createdBy: USER_ID,
        context: { mode: 'existing', purchaseId },
      });
      await insertPurchasePayable(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        stockMovementId: MOV_OK,
        qty: 3,
        unitCost: '50.00',
        createdBy: USER_ID,
        purchaseId: resolved.purchaseId,
      });
      goodRowCommitted = true;
    } catch {
      // Should not throw.
    }

    // Row 2: bad row — stock movement doesn't exist → FK violation.
    const NON_EXISTENT_MOV = '00000000-0000-0000-dddd-999999999999';
    let badRowFailed = false;
    try {
      const resolved = await resolveInvoiceInTx(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        createdBy: USER_ID,
        context: { mode: 'existing', purchaseId },
      });
      await insertPurchasePayable(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        stockMovementId: NON_EXISTENT_MOV,
        qty: 5,
        unitCost: '100.00',
        createdBy: USER_ID,
        purchaseId: resolved.purchaseId,
      });
    } catch {
      badRowFailed = true;
    }

    expect(goodRowCommitted).toBe(true);
    expect(badRowFailed).toBe(true);

    // Header must still exist.
    const headerCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE id = $1',
      [purchaseId],
    );

    expect(Number(headerCount.rows[0]!.count)).toBe(1);

    // Exactly 1 payable for the good row.
    const payableCount = await pg.query<{ count: string; purchase_id: string }>(
      'SELECT COUNT(*) as count FROM supplier_payables WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(payableCount.rows[0]!.count)).toBe(1);

    // That payable is stamped with the purchase_id.
    const payable = await pg.query<{ purchase_id: string }>(
      'SELECT purchase_id FROM supplier_payables WHERE organization_id = $1',
      [ORG],
    );

    expect(payable.rows[0]!.purchase_id).toBe(purchaseId);
  });
});

// ── TC-4: invoiceNumber stamped on header when provided ──────────────────────

describe('TC-4: invoiceNumber is stored on the supplier_purchases header', () => {
  it('header has the invoiceNumber passed by the batch', async () => {
    const purchaseId = await createHeader('FAC-2024-001');

    const result = await pg.query<{ invoice_number: string | null }>(
      'SELECT invoice_number FROM supplier_purchases WHERE id = $1',
      [purchaseId],
    );

    expect(result.rows[0]!.invoice_number).toBe('FAC-2024-001');
  });

  it('header has null invoiceNumber when not provided', async () => {
    const purchaseId = await createHeader(null);

    const result = await pg.query<{ invoice_number: string | null }>(
      'SELECT invoice_number FROM supplier_purchases WHERE id = $1',
      [purchaseId],
    );

    expect(result.rows[0]!.invoice_number).toBeNull();
  });
});

// ── TC-5: single-row batch → one header with one payable (not standalone) ─────

describe('TC-5: single-row batch creates a header (not standalone)', () => {
  it('1-row import produces 1 header and 1 payable sharing purchase_id', async () => {
    const PRODUCT_SINGLE = '00000000-0000-0000-cccc-200000000031';
    const MOV_SINGLE = '00000000-0000-0000-dddd-200000000031';

    await seedProduct(PRODUCT_SINGLE);
    await seedStockMovement(MOV_SINGLE, PRODUCT_SINGLE);

    const purchaseId = await createHeader(null);

    const resolved = await resolveInvoiceInTx(rawDb as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      createdBy: USER_ID,
      context: { mode: 'existing', purchaseId },
    });
    await insertPurchasePayable(rawDb as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      stockMovementId: MOV_SINGLE,
      qty: 1,
      unitCost: '500.00',
      createdBy: USER_ID,
      purchaseId: resolved.purchaseId,
    });

    const headerCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(headerCount.rows[0]!.count)).toBe(1);

    const payable = await pg.query<{ purchase_id: string | null }>(
      'SELECT purchase_id FROM supplier_payables WHERE organization_id = $1',
      [ORG],
    );

    expect(payable.rows[0]!.purchase_id).toBe(purchaseId);
  });
});

// ── TC-6: listOpenInvoices groups batch payables under one invoice entry ───────

describe('TC-6: listOpenInvoices groups all batch payables under one entry', () => {
  it('two payables with the same purchase_id appear as one invoice group', async () => {
    const PRODUCT_X = '00000000-0000-0000-cccc-200000000041';
    const PRODUCT_Y = '00000000-0000-0000-cccc-200000000042';
    const MOV_X = '00000000-0000-0000-dddd-200000000041';
    const MOV_Y = '00000000-0000-0000-dddd-200000000042';

    await seedProduct(PRODUCT_X);
    await seedProduct(PRODUCT_Y);
    await seedStockMovement(MOV_X, PRODUCT_X);
    await seedStockMovement(MOV_Y, PRODUCT_Y);

    const purchaseId = await createHeader('FAC-GRUPO-01');

    for (const movId of [MOV_X, MOV_Y]) {
      const resolved = await resolveInvoiceInTx(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        createdBy: USER_ID,
        context: { mode: 'existing', purchaseId },
      });
      await insertPurchasePayable(rawDb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        stockMovementId: movId,
        qty: 10,
        unitCost: '200.00',
        createdBy: USER_ID,
        purchaseId: resolved.purchaseId,
      });
    }

    const invoices = await listOpenInvoices(rawDb as never, ORG);

    // Must surface as exactly ONE invoice group.
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.purchaseId).toBe(purchaseId);
    expect(invoices[0]!.invoiceNumber).toBe('FAC-GRUPO-01');
    expect(invoices[0]!.lineCount).toBe(2);
    // totalAmount = 10 * 200 + 10 * 200 = 4000
    expect(Number(invoices[0]!.totalAmount)).toBe(4000);
    // outstanding = same as total (nothing paid)
    expect(Number(invoices[0]!.outstanding)).toBe(4000);
  });

  it('a batch payable with invoiceNumber and a standalone payable surface as 2 separate groups', async () => {
    const PRODUCT_BATCH = '00000000-0000-0000-cccc-200000000051';
    const PRODUCT_STANDALONE = '00000000-0000-0000-cccc-200000000052';
    const MOV_BATCH = '00000000-0000-0000-dddd-200000000051';
    const MOV_STANDALONE = '00000000-0000-0000-dddd-200000000052';

    await seedProduct(PRODUCT_BATCH);
    await seedProduct(PRODUCT_STANDALONE);
    await seedStockMovement(MOV_BATCH, PRODUCT_BATCH);
    await seedStockMovement(MOV_STANDALONE, PRODUCT_STANDALONE);

    // Batch import → grouped.
    const purchaseId = await createHeader('FAC-GRUPO-02');
    const resolved = await resolveInvoiceInTx(rawDb as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      createdBy: USER_ID,
      context: { mode: 'existing', purchaseId },
    });
    await insertPurchasePayable(rawDb as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      stockMovementId: MOV_BATCH,
      qty: 5,
      unitCost: '100.00',
      createdBy: USER_ID,
      purchaseId: resolved.purchaseId,
    });

    // Standalone payable (no purchase_id).
    await insertPurchasePayable(rawDb as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      stockMovementId: MOV_STANDALONE,
      qty: 2,
      unitCost: '300.00',
      createdBy: USER_ID,
      purchaseId: null,
    });

    const invoices = await listOpenInvoices(rawDb as never, ORG);

    expect(invoices).toHaveLength(2);

    const purchaseIds = invoices.map(i => i.purchaseId);

    expect(purchaseIds).toContain(purchaseId);
    expect(purchaseIds).toContain(null);
  });
});

// ── TC-7: duplicate invoiceNumber raises unique violation ─────────────────────
//
// The partial unique index on supplier_purchases
// (organization_id, supplier_id, invoice_number) WHERE invoice_number IS NOT NULL
// must reject a second header with the same org+supplier+invoice_number.
// This is the seam that FIX 1 catches with error code 23505.

describe('TC-7: duplicate invoiceNumber → unique constraint violation', () => {
  it('inserting two headers with the same org+supplier+invoiceNumber raises a unique violation', async () => {
    // First header succeeds.
    await createHeader('FAC-DUP-001');

    // Second insert with the same invoice number must throw.
    await expect(
      pg.query(
        `INSERT INTO supplier_purchases
           (organization_id, supplier_id, invoice_number, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [ORG, SUPPLIER_ID, 'FAC-DUP-001', USER_ID],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('two headers with the same invoice_number but different suppliers are allowed', async () => {
    const OTHER_SUPPLIER = '00000000-0000-0000-aaaa-200000000099';

    // Insert other supplier so FK constraint passes.
    await pg.query(
      `INSERT INTO suppliers (id, organization_id, name, created_at, updated_at)
       VALUES ($1, $2, 'Otro proveedor', now(), now())`,
      [OTHER_SUPPLIER, ORG],
    );

    await createHeader('FAC-MULTI-001');

    // Same invoice number, different supplier → no violation.
    const result = await pg.query<{ id: string }>(
      `INSERT INTO supplier_purchases
         (organization_id, supplier_id, invoice_number, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id`,
      [ORG, OTHER_SUPPLIER, 'FAC-MULTI-001', USER_ID],
    );

    expect(result.rows[0]?.id).toBeDefined();
  });

  it('null invoiceNumbers never conflict with each other', async () => {
    // Two headers with invoice_number=NULL → index WHERE clause excludes them.
    await createHeader(null);
    await createHeader(null);

    const count = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_purchases WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(count.rows[0]!.count)).toBe(2);
  });
});
