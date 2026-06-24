import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeCashBreakdown } from '@/libs/cash-helpers';
import {
  reclassifyPayment,
  reclassifyPosSalePayment,
} from '@/libs/payment-reclassification';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  salePaymentsSchema,
  transferReconciliationsSchema,
} from '@/models/Schema';

// ── PGlite-backed tests for payment reclassification (F5 — the money path) ───

type Executor = Parameters<typeof reclassifyPayment>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'credito_payment', 'reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
];

const DDL = `
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
    resolution_credito_id uuid,
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

const ORG = 'org-1';
const OTHER = 'org-2';
const SALE = '00000000-0000-0000-0000-0000000000aa';
const SESSION = '00000000-0000-0000-0000-0000000000bb';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seedPayment(method: string, amount: string): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db
    .insert(salePaymentsSchema)
    .values({ id, saleId: SALE, method, amount } as any);
  return id;
}

async function payments(): Promise<{ method: string; amount: string }[]> {
  return db
    .select({
      method: salePaymentsSchema.method,
      amount: salePaymentsSchema.amount,
    })
    .from(salePaymentsSchema)
    .where(eq(salePaymentsSchema.saleId, SALE));
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM sale_payments');
  await pg.exec('DELETE FROM sales');
  await pg.exec('DELETE FROM cash_sessions');
  counter = 0;
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, opened_by, status) VALUES ($1, $2, 'owner', 'open')`,
    [SESSION, ORG],
  );
  await pg.query(
    `INSERT INTO sales (id, organization_id, pos_token_id) VALUES ($1, $2, NULL)`,
    [SALE, ORG],
  );
});

describe('reclassifyPayment — cash to transfer (the mis-entered mixed case)', () => {
  it('splits the payment, posts a negative cash delta, and opens a reconciliation', async () => {
    // Original sale booked $50 cash → its sale cash movement raised expected by 50.
    await pg.query(
      `INSERT INTO cash_movements (session_id, organization_id, type, amount, reason, created_by) VALUES ($1, $2, 'sale', '50.00', 'Venta', 'cajero')`,
      [SESSION, ORG],
    );
    const cashPayment = await seedPayment('Efectivo', '50.00');

    const res = await reclassifyPayment(db, {
      organizationId: ORG,
      salePaymentId: cashPayment,
      toMethod: 'Transferencia',
      amount: 20,
      currentSessionId: SESSION,
      createdBy: 'owner',
    });

    expect(res.ok).toBe(true);

    const split = await payments();
    const byMethod = Object.fromEntries(split.map(p => [p.method, p.amount]));

    expect(byMethod.Efectivo).toBe('30.00');
    expect(byMethod.Transferencia).toBe('20.00');

    // A signed reclassification movement of -20 (the cash that was never cash).
    const [recl] = await db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.type, 'reclassification'));

    expect(recl?.amount).toBe('-20.00');

    // The transfer is now queued for reconciliation.
    const [recon] = await db
      .select()
      .from(transferReconciliationsSchema)
      .where(eq(transferReconciliationsSchema.method, 'Transferencia'));

    expect(recon?.expectedAmount).toBe('20.00');
    expect(recon?.status).toBe('pending');

    // The arqueo now expects the real cash: 50 (sale) - 20 (reclass) = 30.
    const breakdown = await computeCashBreakdown(db, {
      id: SESSION,
      openingAmount: '0',
    });

    expect(breakdown.reclassifications).toBe(-20);
    expect(breakdown.expected).toBe(30);
  });
});

describe('reclassifyPayment — transfer to cash', () => {
  it('raises expected cash and shrinks the source reconciliation', async () => {
    const transferPayment = await seedPayment('Transferencia', '50.00');
    // The transfer payment already had its pending reconciliation.
    await db.insert(transferReconciliationsSchema).values({
      organizationId: ORG,
      salePaymentId: transferPayment,
      method: 'Transferencia',
      expectedAmount: '50.00',
      status: 'pending',
    } as any);

    const res = await reclassifyPayment(db, {
      organizationId: ORG,
      salePaymentId: transferPayment,
      toMethod: 'Efectivo',
      amount: 20,
      currentSessionId: SESSION,
      createdBy: 'owner',
    });

    expect(res.ok).toBe(true);

    const [recl] = await db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.type, 'reclassification'));

    expect(recl?.amount).toBe('20.00'); // cash entered the drawer

    // Source reconciliation shrank to the remaining transfer amount.
    const [recon] = await db
      .select()
      .from(transferReconciliationsSchema)
      .where(
        and(
          eq(transferReconciliationsSchema.salePaymentId, transferPayment),
          eq(transferReconciliationsSchema.organizationId, ORG),
        ),
      );

    expect(recon?.expectedAmount).toBe('30.00');

    const breakdown = await computeCashBreakdown(db, {
      id: SESSION,
      openingAmount: '0',
    });

    expect(breakdown.expected).toBe(20);
  });
});

describe('reclassifyPayment — guards', () => {
  it('rejects moving more than the payment holds', async () => {
    const p = await seedPayment('Efectivo', '50.00');
    const res = await reclassifyPayment(db, {
      organizationId: ORG,
      salePaymentId: p,
      toMethod: 'Transferencia',
      amount: 60,
      currentSessionId: SESSION,
      createdBy: 'owner',
    });

    expect(res).toEqual({
      ok: false,
      error: 'No podés reclasificar más de lo que tiene ese pago',
    });
  });

  it('does not find a payment from another org (tenant isolation)', async () => {
    const p = await seedPayment('Efectivo', '50.00');
    const res = await reclassifyPayment(db, {
      organizationId: OTHER,
      salePaymentId: p,
      toMethod: 'Transferencia',
      amount: 10,
      currentSessionId: SESSION,
      createdBy: 'owner',
    });

    expect(res).toEqual({ ok: false, error: 'Pago no encontrado' });
  });
});

// ── POS "error de carga": in-shift guard ─────────────────────────────────────
// The cashier may only correct a sale from THEIR CURRENT shift — same device and
// created at/after the open session started. Correcting a past/closed-shift sale
// would post the cash delta into today's session and re-open a descuadre.

describe('reclassifyPosSalePayment — in-shift guard', () => {
  // openedAt is read from the DB so it shares the same timestamp parsing as the
  // sale's created_at (both timestamp-without-tz). In production both come from
  // the DB, so the relative comparison is always consistent regardless of TZ.
  async function openSessionOpenedAt(): Promise<Date> {
    const [s] = await db
      .select({ openedAt: cashSessionsSchema.openedAt })
      .from(cashSessionsSchema)
      .where(eq(cashSessionsSchema.id, SESSION))
      .limit(1);
    return s!.openedAt;
  }

  it('reclassifies a current-shift sale (same device, created after open)', async () => {
    const cashPayment = await seedPayment('Efectivo', '50.00');

    const res = await reclassifyPosSalePayment(db, {
      organizationId: ORG,
      session: {
        id: SESSION,
        openedAt: await openSessionOpenedAt(),
        posTokenId: null,
      },
      salePaymentId: cashPayment,
      toMethod: 'Transferencia',
      amount: 20,
      createdBy: 'cajero',
    });

    expect(res.ok).toBe(true);

    const byMethod = Object.fromEntries(
      (await payments()).map(p => [p.method, p.amount]),
    );

    expect(byMethod.Efectivo).toBe('30.00');
    expect(byMethod.Transferencia).toBe('20.00');
  });

  it('rejects a sale created BEFORE the open session (past shift)', async () => {
    // Force the sale far into the past — before any open session could start.
    await pg.query(
      `UPDATE sales SET created_at = '2000-01-01 00:00:00' WHERE id = $1`,
      [SALE],
    );
    const cashPayment = await seedPayment('Efectivo', '50.00');

    const res = await reclassifyPosSalePayment(db, {
      organizationId: ORG,
      session: {
        id: SESSION,
        openedAt: await openSessionOpenedAt(),
        posTokenId: null,
      },
      salePaymentId: cashPayment,
      toMethod: 'Transferencia',
      amount: 20,
      createdBy: 'cajero',
    });

    expect(res).toEqual({
      ok: false,
      error: 'Solo podés corregir una venta del turno actual',
    });
  });

  it('rejects a sale from another device (posToken mismatch)', async () => {
    const cashPayment = await seedPayment('Efectivo', '50.00');

    const res = await reclassifyPosSalePayment(db, {
      organizationId: ORG,
      // The seeded sale has posTokenId NULL; this session is a different device.
      session: {
        id: SESSION,
        openedAt: await openSessionOpenedAt(),
        posTokenId: UUID(777),
      },
      salePaymentId: cashPayment,
      toMethod: 'Transferencia',
      amount: 20,
      createdBy: 'cajero',
    });

    expect(res).toEqual({
      ok: false,
      error: 'Solo podés corregir una venta del turno actual',
    });
  });

  it('does not find a payment from another org (tenant isolation)', async () => {
    const cashPayment = await seedPayment('Efectivo', '50.00');

    const res = await reclassifyPosSalePayment(db, {
      organizationId: OTHER,
      session: {
        id: SESSION,
        openedAt: await openSessionOpenedAt(),
        posTokenId: null,
      },
      salePaymentId: cashPayment,
      toMethod: 'Transferencia',
      amount: 20,
      createdBy: 'cajero',
    });

    expect(res).toEqual({ ok: false, error: 'Pago no encontrado' });
  });
});
