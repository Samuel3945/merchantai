import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { salePaymentsAggJson } from '@/libs/pos-sales-payments-agg';
import { salesSchema } from '@/models/Schema';

// Validates the correlated-subquery fragment the POS sales list uses to expose
// each sale's payment split. Tested directly (the route module itself isn't
// unit-importable — it drags in the whole create-sale graph).

const DDL = `
  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL
  );
  CREATE TABLE sale_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL
  );
`;

const MIXED = '00000000-0000-0000-0000-000000000001';
const EMPTY = '00000000-0000-0000-0000-000000000002';

type PaymentJson = { id: string; method: string; amount: string | number };

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM sale_payments');
  await pg.exec('DELETE FROM sales');
  await pg.query(`INSERT INTO sales (id, organization_id) VALUES ($1, 'org'), ($2, 'org')`, [
    MIXED,
    EMPTY,
  ]);
  await pg.query(
    `INSERT INTO sale_payments (sale_id, method, amount)
     VALUES ($1, 'Efectivo', '30.00'), ($1, 'Transferencia', '20.00')`,
    [MIXED],
  );
});

describe('salePaymentsAggJson', () => {
  async function paymentsFor(saleId: string): Promise<PaymentJson[]> {
    const rows = await db
      .select({ id: salesSchema.id, payments: salePaymentsAggJson() })
      .from(salesSchema);
    const row = rows.find(r => r.id === saleId);
    return (row?.payments ?? []) as PaymentJson[];
  }

  it('returns the full split for a mixed-payment sale', async () => {
    const payments = await paymentsFor(MIXED);

    expect(payments).toHaveLength(2);

    const byMethod = Object.fromEntries(
      payments.map(p => [p.method, Number(p.amount)]),
    );

    expect(byMethod.Efectivo).toBe(30);
    expect(byMethod.Transferencia).toBe(20);
    // Each payment carries its id so the cashier app can target it.
    expect(payments.every(p => typeof p.id === 'string')).toBe(true);
  });

  it('returns [] for a sale with no payment rows', async () => {
    const payments = await paymentsFor(EMPTY);

    expect(payments).toEqual([]);
  });
});
