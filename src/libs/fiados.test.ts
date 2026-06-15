import type { Executor } from '@/libs/fiados';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFiado,
  extendFiadoTermTx,
  isCashMethod,
  recordAbonoTx,
} from '@/libs/fiados';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  fiadoMovementsSchema,
  fiadosSchema,
} from '@/models/Schema';

// ── PGlite-backed integration tests for the fiados core ────────────────────
//
// These tests exercise createFiado, recordAbonoTx and extendFiadoTermTx
// against a real Postgres engine so we catch SQL shape problems, transaction
// isolation gaps, and money-distribution bugs that unit tests on pure
// functions can't.
//
// The session-scoped Caja link is tested thoroughly: cash abonos create a
// drawer movement; digital abonos never touch the drawer; no open session →
// abono still saved but hitCaja=false.

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "fiado_status" AS ENUM('pending', 'paid', 'written_off')`,
  `CREATE TYPE "fiado_movement_type" AS ENUM('charge', 'payment', 'extension', 'writeoff', 'adjustment')`,
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'fiado_payment')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
];

const DDL = `
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
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
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
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE fiados (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid,
    sale_id uuid,
    original_amount numeric(12, 2) NOT NULL,
    due_date date NOT NULL,
    status "fiado_status" DEFAULT 'pending' NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
    pos_token_id uuid,
    cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
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
    resolution_fiado_id uuid REFERENCES fiados(id) ON DELETE SET NULL,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE fiado_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    fiado_id uuid NOT NULL REFERENCES fiados(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "fiado_movement_type" NOT NULL,
    amount numeric(12, 2) DEFAULT '0' NOT NULL,
    method text,
    cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE SET NULL,
    transfer_reconciliation_id uuid REFERENCES transfer_reconciliations(id) ON DELETE SET NULL,
    due_date_before date,
    due_date_after date,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE INDEX fiados_org_status_idx ON fiados (organization_id, status);
  CREATE INDEX fiados_org_due_date_idx ON fiados (organization_id, due_date);
  CREATE UNIQUE INDEX fiados_sale_unique_idx ON fiados (sale_id) WHERE sale_id IS NOT NULL;
  CREATE INDEX fiado_movements_fiado_created_idx ON fiado_movements (fiado_id, created_at);
`;

const ORG = 'org-test';
const USER = 'user-test';

// Deterministic UUIDs so error traces are readable and tests are reproducible.
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

// Cleanup between tests to prevent cross-test contamination.
let fiadoCounter = 0;

beforeEach(async () => {
  await pg.exec('DELETE FROM fiado_movements');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM fiados');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM app_settings WHERE key = \'fiados-default-term-days\'');
  fiadoCounter = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function openSession(): Promise<string> {
  const [s] = await db
    .insert(cashSessionsSchema)
    .values({
      organizationId: ORG,
      openedBy: 'cajero',
      openingAmount: '0',
      status: 'open' as const,
    })
    .returning({ id: cashSessionsSchema.id });
  return s!.id;
}

async function seedFiado(overrides: Record<string, unknown> = {}): Promise<string> {
  fiadoCounter++;
  const idx = fiadoCounter;
  const defaults = {
    id: UUID(idx),
    organizationId: ORG,
    originalAmount: '100.00',
    dueDate: '2026-07-01',
    status: 'pending' as const,
    notes: 'Cliente: Juan Perez | Tel: 300',
    saleId: UUID(1000 + idx),
    ...overrides,
  };
  await db.insert(fiadosSchema).values(defaults as any);
  return String(defaults.id); // May be overridden — return actual id.
}
// Correct base64url of "Juan Perez||300".
const JUAN_KEY = 'n:SnVhbiBQZXJlenx8MzAw';

async function closeAllSessions(): Promise<void> {
  await pg.exec(`UPDATE cash_sessions SET status = 'closed', closed_at = now()`);
}

// ── createFiado ──────────────────────────────────────────────────────────

describe('createFiado', () => {
  it('creates a fiado row and a charge movement', async () => {
    const result = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2001),
      originalAmount: '150.00',
      dueDate: '2026-07-15',
      notes: 'Cliente: Ana',
      createdBy: USER,
    });

    expect(result).not.toBeNull();

    const fiadoId = result!.id;

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, fiadoId))
      .execute();

    expect(fiado).toBeDefined();
    expect(fiado!.originalAmount).toBe('150.00');
    expect(fiado!.dueDate).toBe('2026-07-15');
    expect(fiado!.status).toBe('pending');

    const movements = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.fiadoId, fiadoId))
      .execute();

    expect(movements).toHaveLength(1);
    expect(movements[0]!.type).toBe('charge');
    expect(movements[0]!.amount).toBe('150.00');
  });

  it('returns null for a zero amount', async () => {
    const result = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2002),
      originalAmount: '0',
      createdBy: USER,
    });

    expect(result).toBeNull();
  });

  it('returns null for a negative amount', async () => {
    const result = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2003),
      originalAmount: '-50.00',
      createdBy: USER,
    });

    expect(result).toBeNull();
  });

  it('is idempotent on saleId (onConflictDoNothing returns null)', async () => {
    const first = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2004),
      originalAmount: '200.00',
      dueDate: '2026-08-01',
      createdBy: USER,
    });

    expect(first).not.toBeNull();

    // onConflictDoNothing suppresses the duplicate but .returning() gets no row,
    // so createFiado returns null — the caller treats null as "already done."
    const second = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2004),
      originalAmount: '999.00',
      dueDate: '2026-09-01',
      createdBy: USER,
    });

    expect(second).toBeNull();

    // Still only one charge movement.
    const movements = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.fiadoId, first!.id))
      .execute();

    expect(movements).toHaveLength(1);
  });

  it('uses explicit dueDate when provided', async () => {
    const result = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2005),
      originalAmount: '50.00',
      dueDate: '2026-12-25',
      createdBy: USER,
    });

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, result!.id))
      .execute();

    expect(fiado!.dueDate).toBe('2026-12-25');
  });

  it('computes dueDate from the default term when not provided', async () => {
    await db.insert(appSettingsSchema).values({
      organizationId: ORG,
      key: 'fiados-default-term-days',
      value: '15',
    } as any);

    const createdAt = new Date('2026-06-01T12:00:00Z');
    const result = await createFiado(db, {
      organizationId: ORG,
      saleId: UUID(2006),
      originalAmount: '80.00',
      createdBy: USER,
      createdAt,
    });

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, result!.id))
      .execute();

    expect(fiado!.dueDate).toBe('2026-06-16');
  });
});

// ── recordAbonoTx ────────────────────────────────────────────────────────

describe('recordAbonoTx', () => {
  beforeEach(async () => {
    await openSession();
  });

  // base64url("Juan Perez||300") = SnVhbiBQZXJlenx8MzAw
  // Uses the module-level constant defined after seedFiado.

  it('partial abono reduces one fiado without settling it', async () => {
    const fId = await seedFiado(/* uses defaults */);

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '40.00',
      method: 'efectivo',
      createdBy: USER,
    });

    expect(result.applied).toBe(40);
    expect(result.remaining).toBe(0);
    expect(result.paidFiadoIds).toEqual([]);
    expect(result.hitCaja).toBe(true);
    expect(result.cashMovementId).not.toBeNull();

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, fId))
      .execute();

    expect(fiado!.status).toBe('pending');
  });

  it('exact abono settles the fiado', async () => {
    const fId = await seedFiado();

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'efectivo',
      createdBy: USER,
    });

    expect(result.applied).toBe(100);
    expect(result.remaining).toBe(0);
    expect(result.paidFiadoIds).toEqual([fId]);

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, fId))
      .execute();

    expect(fiado!.status).toBe('paid');
  });

  it('overpayment leaves change as remaining', async () => {
    const fId = await seedFiado();

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '150.00',
      method: 'efectivo',
      createdBy: USER,
    });

    expect(result.applied).toBe(100);
    expect(result.remaining).toBe(50);
    expect(result.paidFiadoIds).toEqual([fId]);
  });

  it('FIFO: distributes across multiple fiados oldest-first', async () => {
    const oldId = await seedFiado({
      id: UUID(10),
      saleId: UUID(2010),
      originalAmount: '100.00',
      dueDate: '2026-06-01',
    });
    const newId = await seedFiado({
      id: UUID(11),
      saleId: UUID(2011),
      originalAmount: '200.00',
      dueDate: '2026-07-01',
    });

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '250.00',
      method: 'transferencia',
      createdBy: USER,
    });

    expect(result.applied).toBe(250);
    expect(result.remaining).toBe(0);
    expect(result.paidFiadoIds).toContain(oldId);
    expect(result.paidFiadoIds).not.toContain(newId);

    const [oldFiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, oldId))
      .execute();

    expect(oldFiado!.status).toBe('paid');

    const [newFiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, newId))
      .execute();

    expect(newFiado!.status).toBe('pending');
  });

  it('digital method does NOT create a cash movement', async () => {
    await seedFiado();

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'nequi',
      createdBy: USER,
    });

    expect(result.hitCaja).toBe(false);
    expect(result.cashMovementId).toBeNull();
    expect(result.applied).toBe(100);
  });

  it('cash method without open session: auto-creates session, hitCaja=true', async () => {
    await closeAllSessions();
    await seedFiado();

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '50.00',
      method: 'efectivo',
      createdBy: USER,
    });

    // Auto-creates a session so the cash is always accounted for.
    expect(result.hitCaja).toBe(true);
    expect(result.cashMovementId).not.toBeNull();
    expect(result.applied).toBe(50);

    // Verify the auto-created session exists and is open.
    const [autoSession] = await db
      .select()
      .from(cashSessionsSchema)
      .where(eq(cashSessionsSchema.status, 'open' as any))
      .execute();

    expect(autoSession).toBeDefined();
    expect(autoSession!.notes).toContain('Auto-abierta');

    const movements = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.type, 'payment' as any))
      .execute();

    expect(movements.length).toBeGreaterThanOrEqual(1);
  });

  it('throws when client has no pending fiados', async () => {
    await expect(
      recordAbonoTx(db, {
        organizationId: ORG,
        clientKey: 'c:nonexistent',
        amount: '50.00',
        method: 'efectivo',
        createdBy: USER,
      }),
    ).rejects.toThrow('No se encontraron fiados pendientes');
  });

  it('throws when method is "fiado"', async () => {
    await seedFiado();

    await expect(
      recordAbonoTx(db, {
        organizationId: ORG,
        clientKey: JUAN_KEY,
        amount: '50.00',
        method: 'fiado',
        createdBy: USER,
      }),
    ).rejects.toThrow('El abono no puede ser de tipo fiado');
  });

  it('throws for zero amount', async () => {
    await expect(
      recordAbonoTx(db, {
        organizationId: ORG,
        clientKey: JUAN_KEY,
        amount: '0',
        method: 'efectivo',
        createdBy: USER,
      }),
    ).rejects.toThrow('El abono debe ser mayor a 0');
  });

  it('throws when method is empty', async () => {
    await expect(
      recordAbonoTx(db, {
        organizationId: ORG,
        clientKey: JUAN_KEY,
        amount: '10.00',
        method: '',
        createdBy: USER,
      }),
    ).rejects.toThrow('Método de pago requerido');
  });

  it('Daviplata method is classified as digital (no cash movement)', async () => {
    await seedFiado();

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'Daviplata',
      createdBy: USER,
    });

    expect(result.hitCaja).toBe(false);
    expect(result.cashMovementId).toBeNull();
    expect(result.applied).toBe(100);
  });

  it('records a note on the payment movement', async () => {
    const fId = await seedFiado();

    await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '30.00',
      method: 'efectivo',
      note: 'Abono parcial del viernes',
      createdBy: USER,
    });

    const movements = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.fiadoId, fId))
      .execute();
    const payments = movements.filter(m => m.type === 'payment');

    expect(payments[0]!.note).toBe('Abono parcial del viernes');
  });

  it('settles a stale zero-balance fiado and continues to the next', async () => {
    const fId = await seedFiado({
      id: UUID(20),
      saleId: UUID(2020),
      originalAmount: '100.00',
    });
    // Simulate prior full payment but status was never updated.
    await db.insert(fiadoMovementsSchema).values({
      fiadoId: fId,
      organizationId: ORG,
      type: 'payment' as const,
      amount: '100.00',
      method: 'efectivo',
      createdBy: USER,
    } as any);
    // Leave fiado.status = 'pending' (stale).

    await seedFiado({
      id: UUID(21),
      saleId: UUID(2021),
      originalAmount: '50.00',
      dueDate: '2026-08-01',
    });

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '50.00',
      method: 'efectivo',
      createdBy: USER,
    });

    // Both should be settled.
    expect(result.paidFiadoIds).toContain(fId);
    expect(result.paidFiadoIds.length).toBe(2);
    expect(result.applied).toBe(50);
  });

  it('isCashMethod correctly identifies cash vs digital', () => {
    expect(isCashMethod('efectivo')).toBe(true);
    expect(isCashMethod('cash')).toBe(true);
    expect(isCashMethod('EFECTIVO')).toBe(true);
    expect(isCashMethod('nequi')).toBe(false);
    expect(isCashMethod('transferencia')).toBe(false);
    expect(isCashMethod('daviplata')).toBe(false);
  });
});

// ── extendFiadoTermTx ────────────────────────────────────────────────────

describe('extendFiadoTermTx', () => {
  it('extends the due date and creates an extension movement', async () => {
    const fId = await seedFiado({
      id: UUID(30),
      saleId: UUID(2030),
      dueDate: '2026-07-01',
    });

    const result = await extendFiadoTermTx(db, {
      organizationId: ORG,
      fiadoId: fId,
      newDueDate: '2026-08-15',
      reason: 'Cliente pidió más plazo',
      createdBy: USER,
    });

    expect(result.dueDateBefore).toBe('2026-07-01');
    expect(result.dueDateAfter).toBe('2026-08-15');

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, fId))
      .execute();

    expect(fiado!.dueDate).toBe('2026-08-15');

    const movements = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.fiadoId, fId))
      .execute();
    const extensions = movements.filter(m => m.type === 'extension');

    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.dueDateBefore).toBe('2026-07-01');
    expect(extensions[0]!.dueDateAfter).toBe('2026-08-15');
    expect(extensions[0]!.note).toBe('Cliente pidió más plazo');
    // Postgres numeric(12,2) returns '0.00' via drizzle.
    expect(Number.parseFloat(extensions[0]!.amount ?? '0')).toBe(0);
  });

  it('throws for invalid date format', async () => {
    const fId = await seedFiado({ id: UUID(31), saleId: UUID(2031) });

    await expect(
      extendFiadoTermTx(db, {
        organizationId: ORG,
        fiadoId: fId,
        newDueDate: 'not-a-date',
        createdBy: USER,
      }),
    ).rejects.toThrow('Fecha de vencimiento inválida');
  });

  it('throws for a non-existent fiado', async () => {
    await expect(
      extendFiadoTermTx(db, {
        organizationId: ORG,
        fiadoId: UUID(9999),
        newDueDate: '2026-09-01',
        createdBy: USER,
      }),
    ).rejects.toThrow('Fiado no encontrado o ya pagado');
  });

  it('throws for a paid fiado', async () => {
    const fId = await seedFiado({
      id: UUID(32),
      saleId: UUID(2032),
      status: 'paid' as const,
    });

    await expect(
      extendFiadoTermTx(db, {
        organizationId: ORG,
        fiadoId: fId,
        newDueDate: '2026-09-01',
        createdBy: USER,
      }),
    ).rejects.toThrow('Fiado no encontrado o ya pagado');
  });

  it('extension with no reason works (nullable note)', async () => {
    const fId = await seedFiado({ id: UUID(33), saleId: UUID(2033) });

    const result = await extendFiadoTermTx(db, {
      organizationId: ORG,
      fiadoId: fId,
      newDueDate: '2026-10-01',
      createdBy: USER,
    });

    expect(result.dueDateBefore).toBeDefined();
    expect(result.dueDateAfter).toBe('2026-10-01');
  });
});

// ── Money precision ──────────────────────────────────────────────────────

describe('money precision', () => {
  beforeEach(async () => {
    await openSession();
  });

  // Uses module-level JUAN_KEY (correct base64url encoding).

  it('preserves cent-exact amounts across multiple fiados', async () => {
    await seedFiado({
      id: UUID(40),
      saleId: UUID(2040),
      originalAmount: '33.33',
      dueDate: '2026-06-01',
    });
    await seedFiado({
      id: UUID(41),
      saleId: UUID(2041),
      originalAmount: '66.67',
      dueDate: '2026-06-15',
    });
    await seedFiado({
      id: UUID(42),
      saleId: UUID(2042),
      originalAmount: '100.00',
      dueDate: '2026-07-01',
    });

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '200.00',
      method: 'efectivo',
      createdBy: USER,
    });

    expect(result.applied).toBe(200);
    expect(result.remaining).toBe(0);

    for (const id of [UUID(40), UUID(41), UUID(42)]) {
      const [f] = await db
        .select()
        .from(fiadosSchema)
        .where(eq(fiadosSchema.id, id))
        .execute();

      expect(f!.status).toBe('paid');
    }
  });

  it('handles many small partial abonos without float drift', async () => {
    const fId = await seedFiado({
      id: UUID(50),
      saleId: UUID(2050),
      originalAmount: '100.00',
      dueDate: '2026-07-01',
    });

    for (let i = 0; i < 20; i++) {
      await recordAbonoTx(db, {
        organizationId: ORG,
        clientKey: JUAN_KEY,
        amount: '5.00',
        method: 'efectivo',
        createdBy: USER,
      });
    }

    const [fiado] = await db
      .select()
      .from(fiadosSchema)
      .where(eq(fiadosSchema.id, fId))
      .execute();

    expect(fiado!.status).toBe('paid');

    // Sum all payment movements for this fiado.
    const payments = await db
      .select()
      .from(fiadoMovementsSchema)
      .where(eq(fiadoMovementsSchema.fiadoId, fId))
      .execute();
    const total = payments
      .filter(m => m.type === 'payment')
      .reduce((s, m) => s + Number.parseFloat(m.amount ?? '0'), 0);

    expect(total).toBe(100);
  });
});

// ── Caja (cash drawer) integration ───────────────────────────────────────

describe('Caja integration', () => {
  it('cash abono creates exactly one cash_movements row with type fiado_payment', async () => {
    const sessionId = await openSession();
    await seedFiado({ id: UUID(60), saleId: UUID(2060) });

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'efectivo',
      createdBy: USER,
    });

    expect(result.hitCaja).toBe(true);
    expect(result.cashMovementId).not.toBeNull();

    const [cm] = await db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.id, result.cashMovementId!))
      .execute();

    expect(cm).toBeDefined();
    expect(cm!.type).toBe('fiado_payment');
    expect(cm!.amount).toBe('100.00');
    expect(cm!.sessionId).toBe(sessionId);
    expect(cm!.organizationId).toBe(ORG);
  });

  it('fiado_payment is counted as income (entradas) in cash breakdown', async () => {
    const sessionId = await openSession();
    await seedFiado({ id: UUID(61), saleId: UUID(2061) });

    await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '75.00',
      method: 'efectivo',
      createdBy: USER,
    });

    const result = await db.execute(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS entradas
       FROM cash_movements
       WHERE session_id = '${sessionId}' AND type IN ('deposit', 'adjustment', 'fiado_payment')`,
    );
    const entradas = Number((result.rows?.[0] as any)?.entradas ?? 0);

    expect(entradas).toBe(75);
  });

  it('fiado_payment is NOT type sale (no double-count in cashSales)', async () => {
    const sessionId = await openSession();
    await seedFiado({ id: UUID(62), saleId: UUID(2062) });

    await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '50.00',
      method: 'efectivo',
      createdBy: USER,
    });

    const result = await db.execute(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS cash_sales
       FROM cash_movements
       WHERE session_id = '${sessionId}' AND type = 'sale'`,
    );
    const cashSales = Number((result.rows?.[0] as any)?.cash_sales ?? 0);

    expect(cashSales).toBe(0);
  });

  it('multiple cash abonos create separate cash movements', async () => {
    const sessionId = await openSession();
    await seedFiado({ id: UUID(63), saleId: UUID(2063), originalAmount: '200.00' });

    await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'efectivo',
      createdBy: USER,
    });
    await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'efectivo',
      createdBy: USER,
    });

    const cashMovements = await db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.sessionId, sessionId))
      .execute();
    const fiadoPayments = cashMovements.filter(cm => cm.type === 'fiado_payment');

    expect(fiadoPayments).toHaveLength(2);
    expect(fiadoPayments[0]!.amount).toBe('100.00');
    expect(fiadoPayments[1]!.amount).toBe('100.00');
  });

  it('digital abono does NOT create a cash movement even with open session', async () => {
    await openSession();
    await seedFiado({ id: UUID(64), saleId: UUID(2064) });

    const result = await recordAbonoTx(db, {
      organizationId: ORG,
      clientKey: JUAN_KEY,
      amount: '100.00',
      method: 'Nequi',
      createdBy: USER,
    });

    expect(result.hitCaja).toBe(false);
    expect(result.cashMovementId).toBeNull();

    const allCash = await db
      .select()
      .from(cashMovementsSchema)
      .execute();

    expect(allCash.filter(cm => cm.type === 'fiado_payment')).toHaveLength(0);
  });
});
