import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bulkConfirmPending,
  confirmReconciliation,
  countPendingReconciliations,
  countReconciliationsByStatus,
  listReconciliations,
  markReconciliationMismatch,
  markReconciliationNotArrived,
  outstandingAmount,
  recordCashierExplanation,
  setReconciliationResolution,
} from '@/libs/transfer-reconciliation';
import { transferReconciliationsSchema } from '@/models/Schema';

// ── PGlite-backed integration tests for the reconciliation lifecycle ─────────

type Executor = Parameters<typeof confirmReconciliation>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
];

const DDL = `
  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
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
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-1';
const OTHER = 'org-2';
const USER = 'Dueño';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seed(overrides: Record<string, unknown> = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db.insert(transferReconciliationsSchema).values({
    id,
    organizationId: ORG,
    method: 'Transferencia',
    expectedAmount: '100.00',
    status: 'pending',
    ...overrides,
  } as any);
  return id;
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
  counter = 0;
});

describe('confirmReconciliation', () => {
  it('confirms a pending transfer, defaulting arrived to expected', async () => {
    const id = await seed();
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(row?.status).toBe('confirmed');
    expect(row?.arrivedAmount).toBe('100.00');
    expect(row?.reconciledBy).toBe(USER);
    expect(row?.reconciledAt).not.toBeNull();
  });

  it('records an explicit arrived amount', async () => {
    const id = await seed();
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 90,
    });

    expect(row?.arrivedAmount).toBe('90.00');
  });

  it('confirms a late arrival (not_arrived -> confirmed)', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(row?.status).toBe('confirmed');
  });

  it('does not touch another org row (tenant isolation)', async () => {
    const id = await seed();
    const row = await confirmReconciliation(db, {
      id,
      organizationId: OTHER,
      reconciledBy: USER,
    });

    expect(row).toBeNull();

    const [still] = await listReconciliations(db, { organizationId: ORG });

    expect(still?.status).toBe('pending');
  });
});

describe('markReconciliationNotArrived', () => {
  it('marks not_arrived with a note and leaves arrived null', async () => {
    const id = await seed();
    const row = await markReconciliationNotArrived(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      note: 'No figura en Nequi',
    });

    expect(row?.status).toBe('not_arrived');
    expect(row?.note).toBe('No figura en Nequi');
    expect(row?.arrivedAmount).toBeNull();
  });
});

describe('markReconciliationMismatch', () => {
  it('marks mismatch with the amount that actually arrived', async () => {
    const id = await seed();
    const row = await markReconciliationMismatch(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 80,
      note: 'Llegó 80 en vez de 100',
    });

    expect(row?.status).toBe('mismatch');
    expect(row?.arrivedAmount).toBe('80.00');
  });
});

describe('bulkConfirmPending', () => {
  it('confirms all pending and leaves non-pending untouched', async () => {
    await seed();
    await seed();
    const skipped = await seed({ status: 'not_arrived' });

    const confirmed = await bulkConfirmPending(db, {
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(confirmed).toBe(2);

    const all = await listReconciliations(db, { organizationId: ORG });

    expect(all.filter(r => r.status === 'confirmed')).toHaveLength(2);
    expect(all.find(r => r.id === skipped)?.status).toBe('not_arrived');
  });

  it('only confirms the given ids when provided', async () => {
    const target = await seed();
    await seed();

    const confirmed = await bulkConfirmPending(db, {
      organizationId: ORG,
      reconciledBy: USER,
      ids: [target],
    });

    expect(confirmed).toBe(1);

    const all = await listReconciliations(db, { organizationId: ORG });

    expect(all.find(r => r.id === target)?.status).toBe('confirmed');
    expect(all.filter(r => r.status === 'pending')).toHaveLength(1);
  });

  it('never confirms another org rows (tenant isolation)', async () => {
    await seed();
    await seed({ organizationId: OTHER });

    const confirmed = await bulkConfirmPending(db, {
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(confirmed).toBe(1);

    const other = await listReconciliations(db, { organizationId: OTHER });

    expect(other[0]?.status).toBe('pending');
  });
});

describe('countPendingReconciliations', () => {
  it('counts and totals only the pending rows', async () => {
    await seed({ expectedAmount: '100.00' });
    await seed({ expectedAmount: '50.00' });
    await seed({ status: 'confirmed', expectedAmount: '999.00' });

    const overview = await countPendingReconciliations(db, {
      organizationId: ORG,
    });

    expect(overview.count).toBe(2);
    expect(overview.total).toBe(150);
  });
});

describe('countReconciliationsByStatus', () => {
  // 00:00 America/Bogota (UTC-5) for 2026-06-15.
  const SINCE = new Date('2026-06-15T05:00:00.000Z');

  it('counts pending, confirmed-today and not_arrived per status', async () => {
    await seed();
    await seed();
    await seed({
      status: 'confirmed',
      reconciledAt: new Date('2026-06-15T14:00:00.000Z'),
    });
    await seed({ status: 'not_arrived' });

    const counts = await countReconciliationsByStatus(db, {
      organizationId: ORG,
      confirmedSince: SINCE,
    });

    expect(counts.pending).toBe(2);
    expect(counts.confirmedToday).toBe(1);
    expect(counts.notArrived).toBe(1);
  });

  it('excludes confirmations made before the start of today', async () => {
    await seed({
      status: 'confirmed',
      reconciledAt: new Date('2026-06-14T20:00:00.000Z'),
    });

    const counts = await countReconciliationsByStatus(db, {
      organizationId: ORG,
      confirmedSince: SINCE,
    });

    expect(counts.confirmedToday).toBe(0);
  });

  it('scopes counts to the org (tenant isolation)', async () => {
    await seed();
    await seed({ organizationId: OTHER });

    const counts = await countReconciliationsByStatus(db, {
      organizationId: ORG,
      confirmedSince: SINCE,
    });

    expect(counts.pending).toBe(1);
  });
});

describe('recordCashierExplanation', () => {
  it('records the explanation with author and timestamp', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await recordCashierExplanation(db, {
      id,
      organizationId: ORG,
      explanation: 'Confirmé el comprobante que el cliente mostró en pantalla',
      explainedBy: 'Cajero Ana',
    });

    expect(row?.cashierExplanation).toContain('comprobante');
    expect(row?.cashierExplainedBy).toBe('Cajero Ana');
    expect(row?.cashierExplainedAt).not.toBeNull();
  });

  it('does not touch another org row (tenant isolation)', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await recordCashierExplanation(db, {
      id,
      organizationId: OTHER,
      explanation: 'x',
      explainedBy: 'y',
    });

    expect(row).toBeNull();
  });
});

describe('setReconciliationResolution', () => {
  it('records a loss outcome with author and timestamp', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
    });

    expect(row?.resolutionType).toBe('loss');
    expect(row?.resolvedBy).toBe(USER);
    expect(row?.resolvedAt).not.toBeNull();
  });

  it('links the fiado when resolved as receivable', async () => {
    const id = await seed({ status: 'not_arrived' });
    const fiadoId = UUID(900);
    const row = await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'receivable',
      resolvedBy: USER,
      resolutionFiadoId: fiadoId,
    });

    expect(row?.resolutionType).toBe('receivable');
    expect(row?.resolutionFiadoId).toBe(fiadoId);
  });

  it('does not touch another org row (tenant isolation)', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await setReconciliationResolution(db, {
      id,
      organizationId: OTHER,
      resolutionType: 'loss',
      resolvedBy: USER,
    });

    expect(row).toBeNull();
  });
});

describe('outstandingAmount', () => {
  it('is the full amount when nothing arrived', () => {
    expect(
      outstandingAmount({ expectedAmount: '100.00', arrivedAmount: null }),
    ).toBe(100);
  });

  it('is the shortfall on a mismatch', () => {
    expect(
      outstandingAmount({ expectedAmount: '100.00', arrivedAmount: '80.00' }),
    ).toBe(20);
  });
});
