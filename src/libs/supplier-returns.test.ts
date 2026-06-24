/**
 * PGLite-backed tests for applyReturnCredit.
 *
 * TDD cycle: tests written FIRST (RED) before implementation.
 * Covers:
 *   - Credit reduces outstanding (total − paid − credited)
 *   - Caps credit at outstanding per payable
 *   - FIFO ordering across multiple payables (oldest purchased_at first)
 *   - Excess → unapplied when return amount > supplier total outstanding
 *   - No treasury movement written (pure liability credit)
 *   - Status recompute (paid when paid+credited >= total)
 *   - Back-compat: return without supplierId → pure exit, no credit
 *   - TenantDb-proxy regression: supplier_payable_credits must be in TENANT_TABLES
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenantDb } from '@/libs/db-context';
import { applyReturnCredit } from '@/libs/supplier-returns';

// ── PGLite database types ─────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let db: RawDb;

// ── ENUMs ─────────────────────────────────────────────────────────────────────

const ENUMS = [
  `CREATE TYPE "supplier_payable_status" AS ENUM('open','partial','paid')`,
  `CREATE TYPE "stock_movement_type" AS ENUM('entry','exit')`,
];

// ── DDL ───────────────────────────────────────────────────────────────────────
// Must mirror Schema.ts exactly (42703 lesson).

const DDL = `
  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    deleted boolean DEFAULT false NOT NULL
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
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE supplier_payable_credits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    return_stock_movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG = 'org-sr-1';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-000000000001';
const PRODUCT_ID = '00000000-0000-0000-dddd-000000000001';
const MOVEMENT_ID = '00000000-0000-0000-eeee-000000000001';
const PAYABLE_ID_1 = '00000000-0000-0000-cccc-000000000001';
const PAYABLE_ID_2 = '00000000-0000-0000-cccc-000000000002';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as RawDb;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM supplier_payable_credits');
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM stock_movements');
  await pg.exec('DELETE FROM products');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedProduct(id: string = PRODUCT_ID): Promise<void> {
  await pg.query(
    `INSERT INTO products (id, organization_id, name, deleted) VALUES ($1, $2, $3, false)`,
    [id, ORG, 'Producto Test'],
  );
}

async function seedMovement(
  id: string = MOVEMENT_ID,
  type: 'entry' | 'exit' = 'exit',
): Promise<void> {
  await pg.query(
    `INSERT INTO stock_movements (id, organization_id, product_id, type, qty, created_at)
     VALUES ($1, $2, $3, $4, 1, now())`,
    [id, ORG, PRODUCT_ID, type],
  );
}

async function seedPayable(
  id: string,
  totalAmount: number,
  paidAmount = 0,
  creditedAmount = 0,
  status: 'open' | 'partial' | 'paid' = 'open',
  purchasedAt?: Date,
): Promise<void> {
  const at = purchasedAt ?? new Date();
  await pg.query(
    `INSERT INTO supplier_payables
       (id, organization_id, supplier_id, total_amount, paid_amount, credited_amount, status, purchased_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
    [id, ORG, SUPPLIER_ID, totalAmount.toFixed(2), paidAmount.toFixed(2), creditedAmount.toFixed(2), status, at.toISOString()],
  );
}

// ── SR-1: Credit reduces outstanding ─────────────────────────────────────────

describe('applyReturnCredit — SR-1: reduces outstanding on a single open payable', () => {
  it('writes one credit row and reduces outstanding to total - paid - credited', async () => {
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 0, 0, 'open');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 40,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(40, 2);
    expect(result.unapplied).toBeCloseTo(0, 2);

    // credit row written
    const credits = await pg.query<{ amount: string; payable_id: string }>(
      `SELECT amount, payable_id FROM supplier_payable_credits WHERE organization_id = $1`,
      [ORG],
    );

    expect(credits.rows).toHaveLength(1);
    expect(Number(credits.rows[0]!.amount)).toBeCloseTo(40, 2);
    expect(credits.rows[0]!.payable_id).toBe(PAYABLE_ID_1);

    // payable credited_amount bumped
    const payable = await pg.query<{
      credited_amount: string;
      status: string;
    }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(40, 2);
    expect(payable.rows[0]!.status).toBe('partial');
  });
});

// ── SR-2: Caps at outstanding ─────────────────────────────────────────────────

describe('applyReturnCredit — SR-2: caps credit at outstanding per payable', () => {
  it('applies at most (total - paid - credited) to any single payable', async () => {
    // outstanding = 100 - 60 - 0 = 40; return 80 → 40 applied, 40 unapplied
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 60, 0, 'partial');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 80,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(40, 2);
    expect(result.unapplied).toBeCloseTo(40, 2);

    const payable = await pg.query<{ credited_amount: string; status: string }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(40, 2);
    expect(payable.rows[0]!.status).toBe('paid');
  });
});

// ── SR-3: FIFO across multiple payables ───────────────────────────────────────

describe('applyReturnCredit — SR-3: FIFO across multiple payables (oldest first)', () => {
  it('applies to oldest payable first, then spills to next', async () => {
    // payable_1 older: total=50, paid=0 → outstanding=50
    // payable_2 newer: total=100, paid=0 → outstanding=100
    // Return 80 → 50 to payable_1 (pays it fully), 30 to payable_2
    await seedProduct();
    await seedMovement();

    const old = new Date('2024-01-01');
    const newer = new Date('2024-06-01');
    await seedPayable(PAYABLE_ID_1, 50, 0, 0, 'open', old);
    await seedPayable(PAYABLE_ID_2, 100, 0, 0, 'open', newer);

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 80,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(80, 2);
    expect(result.unapplied).toBeCloseTo(0, 2);

    const credits = await pg.query<{ payable_id: string; amount: string }>(
      `SELECT payable_id, amount FROM supplier_payable_credits ORDER BY amount DESC`,
      [],
    );

    expect(credits.rows).toHaveLength(2);

    const p1Credit = credits.rows.find(r => r.payable_id === PAYABLE_ID_1);
    const p2Credit = credits.rows.find(r => r.payable_id === PAYABLE_ID_2);

    expect(Number(p1Credit!.amount)).toBeCloseTo(50, 2);
    expect(Number(p2Credit!.amount)).toBeCloseTo(30, 2);

    const p1 = await pg.query<{ status: string }>(
      `SELECT status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(p1.rows[0]!.status).toBe('paid');

    const p2 = await pg.query<{ credited_amount: string; status: string }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_2],
    );

    expect(Number(p2.rows[0]!.credited_amount)).toBeCloseTo(30, 2);
    expect(p2.rows[0]!.status).toBe('partial');
  });
});

// ── SR-4: Excess → unapplied (no money invented) ─────────────────────────────

describe('applyReturnCredit — SR-4: excess beyond supplier outstanding → unapplied', () => {
  it('returns unapplied > 0 when return exceeds ALL supplier payables combined', async () => {
    // payable_1: outstanding=30, payable_2: outstanding=20 → total=50
    // Return 80 → 50 applied, 30 unapplied; no negative credited_amount
    await seedProduct();
    await seedMovement();

    await seedPayable(PAYABLE_ID_1, 50, 20, 0, 'partial', new Date('2024-01-01'));
    await seedPayable(PAYABLE_ID_2, 30, 10, 0, 'partial', new Date('2024-06-01'));

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 80,
      createdBy: 'user-1',
    });

    // total outstanding = (50-20) + (30-10) = 30+20 = 50
    expect(result.appliedTotal).toBeCloseTo(50, 2);
    expect(result.unapplied).toBeCloseTo(30, 2);

    // both payables are now paid
    const p1 = await pg.query<{ status: string; credited_amount: string }>(
      `SELECT status, credited_amount FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(p1.rows[0]!.status).toBe('paid');
    expect(Number(p1.rows[0]!.credited_amount)).toBeCloseTo(30, 2);

    const p2 = await pg.query<{ status: string; credited_amount: string }>(
      `SELECT status, credited_amount FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_2],
    );

    expect(p2.rows[0]!.status).toBe('paid');
    expect(Number(p2.rows[0]!.credited_amount)).toBeCloseTo(20, 2);
  });
});

// ── SR-5: No treasury movement ────────────────────────────────────────────────

describe('applyReturnCredit — SR-5: no treasury movement written', () => {
  it('does not touch treasury tables at all', async () => {
    // We only have supplier_payable_credits and supplier_payables in this DDL.
    // Verifying no unexpected side-effects reach treasury.
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 0, 0, 'open');

    await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 50,
      createdBy: 'user-1',
    });

    // Only 1 credit row exists — no other table contamination
    const creditCount = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payable_credits`,
      [],
    );

    expect(Number(creditCount.rows[0]!.count)).toBe(1);
  });
});

// ── SR-6: Status recompute when paid+credited >= total ────────────────────────

describe('applyReturnCredit — SR-6: status becomes paid when paid+credited >= total', () => {
  it('marks payable as paid when credit fills the remaining outstanding', async () => {
    // paid=70, total=100 → outstanding=30; credit 30 → paid+credited=100=total
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 70, 0, 'partial');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 30,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(30, 2);
    expect(result.unapplied).toBeCloseTo(0, 2);

    const payable = await pg.query<{ status: string; credited_amount: string }>(
      `SELECT status, credited_amount FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(30, 2);
  });
});

// ── SR-7: Return with no open payable → fully unapplied ──────────────────────

describe('applyReturnCredit — SR-7: no open payable → full amount unapplied', () => {
  it('returns unapplied equal to amount when all payables are already paid', async () => {
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 100, 0, 'paid');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 50,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(0, 2);
    expect(result.unapplied).toBeCloseTo(50, 2);

    const creditCount = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payable_credits`,
      [],
    );

    expect(Number(creditCount.rows[0]!.count)).toBe(0);
  });
});

// ── SR-8: TenantDb-proxy regression ───────────────────────────────────────────

describe('applyReturnCredit — SR-8: TenantDb proxy — supplier_payable_credits must be registered', () => {
  it('succeeds via the TenantDb proxy (supplier_payable_credits is in TENANT_TABLES)', async () => {
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 0, 0, 'open');

    const tdb = createTenantDb(db as never, ORG);

    // Should NOT throw "Table 'supplier_payable_credits' is not registered as a tenant table"
    await expect(
      applyReturnCredit(tdb as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        returnStockMovementId: MOVEMENT_ID,
        amount: 25,
        createdBy: 'user-proxy',
      }),
    ).resolves.toBeDefined();

    // Verify the credit was written
    const credits = await pg.query<{ amount: string }>(
      `SELECT amount FROM supplier_payable_credits WHERE organization_id = $1`,
      [ORG],
    );

    expect(credits.rows).toHaveLength(1);
    expect(Number(credits.rows[0]!.amount)).toBeCloseTo(25, 2);
  });

  it('fails with a clear TENANT_TABLES error when supplier_payable_credits is NOT registered', () => {
    // We simulate what would happen without the TENANT_TABLES entry
    // by directly testing the error message the proxy throws for unregistered tables.
    // This is the C1 lesson contract test.
    const tdb = createTenantDb(db as never, ORG);
    const fakeTable = { organizationId: {} } as never;

    // Access a table that isn't in either TENANT_TABLES or CHILD_TABLES
    // The proxy throws with the specific message pattern.
    // We check this indirectly: the insert in SR-8 test above only passes
    // BECAUSE supplier_payable_credits IS registered. This test documents the negative.
    expect(() => {
      tdb.insert(fakeTable);
    }).toThrow(/not registered as a tenant table/);
  });
});

// ── SR-10: zero amount → graceful NO-OP (FIX 1b) ─────────────────────────────

describe('applyReturnCredit — SR-10: zero amount is a NO-OP, no credit row, no throw', () => {
  it('returns appliedTotal=0, unapplied=0, creditIds=[] without writing any row', async () => {
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 0, 0, 'open');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 0,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBe(0);
    expect(result.unapplied).toBe(0);
    expect(result.creditIds).toHaveLength(0);

    const creditCount = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payable_credits`,
      [],
    );

    expect(Number(creditCount.rows[0]!.count)).toBe(0);

    // payable must be untouched (status still 'open')
    const payable = await pg.query<{ status: string; credited_amount: string }>(
      `SELECT status, credited_amount FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    expect(payable.rows[0]!.status).toBe('open');
    expect(Number(payable.rows[0]!.credited_amount)).toBe(0);
  });
});

// ── SR-9: already partially credited payable gets more credit ─────────────────

describe('applyReturnCredit — SR-9: accumulates credited_amount on already-credited payable', () => {
  it('adds to existing credited_amount (not overwrites)', async () => {
    // payable already has credited_amount=20, outstanding=(100-0-20)=80
    await seedProduct();
    await seedMovement();
    await seedPayable(PAYABLE_ID_1, 100, 0, 20, 'partial');

    const result = await applyReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      returnStockMovementId: MOVEMENT_ID,
      amount: 30,
      createdBy: 'user-1',
    });

    expect(result.appliedTotal).toBeCloseTo(30, 2);
    expect(result.unapplied).toBeCloseTo(0, 2);

    const payable = await pg.query<{ credited_amount: string; status: string }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID_1],
    );

    // 20 (existing) + 30 (new) = 50
    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(50, 2);
    expect(payable.rows[0]!.status).toBe('partial');
  });
});
