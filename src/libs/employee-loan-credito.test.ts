/**
 * Integración (PGlite) de los préstamos a empleados (vales) unificados en el
 * sistema de créditos (migración 0092):
 *  - crear un vale → aparece en listOutstandingEmployeeLoans y en el muro
 *    (getCreditosOverview) agrupado bajo `emp:<id>` con isEmployee.
 *  - un abono en caja reduce el saldo y marca 'paid' al saldar por completo.
 *  - un crédito de CLIENTE en la misma org se agrupa por separado y no se ve
 *    afectado.
 */

import type { Executor } from '@/libs/creditos';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as Executor,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

const {
  createCredito,
  createEmployeeLoanCredito,
  getCreditosOverview,
  listOutstandingEmployeeLoans,
  recordEmployeeLoanRepaymentCaja,
} = await import('@/libs/creditos');

const { cashSessionsSchema } = await import('@/models/Schema');

const ENUMS = [
  `CREATE TYPE "credito_status" AS ENUM('pending', 'paid', 'written_off')`,
  `CREATE TYPE "credito_movement_type" AS ENUM('charge', 'payment', 'extension', 'writeoff', 'adjustment')`,
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'credito_payment')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved')`,
];

const DDL = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL
  );

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

  CREATE TABLE creditos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid,
    sale_id uuid,
    employee_id uuid REFERENCES pos_users(id) ON DELETE SET NULL,
    original_amount numeric(12, 2) NOT NULL,
    due_date date NOT NULL,
    status "credito_status" DEFAULT 'pending' NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    method text NOT NULL,
    expected_amount numeric(12, 2) NOT NULL,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE credito_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    credito_id uuid NOT NULL REFERENCES creditos(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "credito_movement_type" NOT NULL,
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

  CREATE INDEX creditos_org_status_idx ON creditos (organization_id, status);
  CREATE UNIQUE INDEX creditos_sale_unique_idx ON creditos (sale_id) WHERE sale_id IS NOT NULL;
`;

const ORG = 'org-emp-loan';
const EMP = '00000000-0000-0000-0000-0000000000e1';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM credito_movements');
  await pg.exec('DELETE FROM creditos');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_users');
  await pg.exec(
    `INSERT INTO pos_users (id, organization_id, name) VALUES ('${EMP}', '${ORG}', 'Juana Pérez')`,
  );
});

async function openSession(): Promise<string> {
  const [s] = await h.db
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

describe('vale a empleado como crédito', () => {
  it('un vale creado aparece en la lista de pendientes y en el muro bajo emp:<id>', async () => {
    const loan = await createEmployeeLoanCredito(h.db, {
      organizationId: ORG,
      employeeId: EMP,
      employeeName: 'Juana Pérez',
      amount: 100000,
      cashMovementId: null,
      createdBy: 'Cajero',
    });

    // 1. Outstanding list (POS /pos/employee-loans wire shape).
    const outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.loanId).toBe(loan.id);
    expect(outstanding[0]!.employeeId).toBe(EMP);
    expect(outstanding[0]!.employeeName).toBe('Juana Pérez');
    expect(outstanding[0]!.totalAmount).toBe(100000);
    expect(outstanding[0]!.outstanding).toBe(100000);

    // 2. Créditos wall groups it under emp:<id> with isEmployee + the name.
    const overview = await getCreditosOverview(ORG);
    const empGroup = overview.clients.find(c => c.clientKey === `emp:${EMP}`);

    expect(empGroup).toBeDefined();
    expect(empGroup!.isEmployee).toBe(true);
    expect(empGroup!.name).toBe('Juana Pérez');
    expect(empGroup!.balance).toBe(100000);
  });

  it('un abono en caja reduce el saldo y marca paid al saldar', async () => {
    const loan = await createEmployeeLoanCredito(h.db, {
      organizationId: ORG,
      employeeId: EMP,
      employeeName: 'Juana Pérez',
      amount: 100000,
      cashMovementId: null,
      createdBy: 'Cajero',
    });
    const sessionId = await openSession();

    // Abono parcial.
    const partial = await recordEmployeeLoanRepaymentCaja(h.db, {
      organizationId: ORG,
      sessionId,
      createdBy: 'Cajero',
      selections: [{ loanId: loan.id, amount: 40000 }],
    });

    expect(partial.appliedTotal).toBe(40000);
    expect(partial.settledLoans).toEqual([]);

    let outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding[0]!.outstanding).toBe(60000);

    // El abono creó una entrada credito_payment (efectivo al cajón).
    const { rows: movRows } = await pg.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cash_movements WHERE type='credito_payment' AND amount='40000.00'`,
    );

    expect(movRows[0]!.n).toBe('1');

    // Abono restante → salda el vale.
    const rest = await recordEmployeeLoanRepaymentCaja(h.db, {
      organizationId: ORG,
      sessionId,
      createdBy: 'Cajero',
      selections: [{ loanId: loan.id, amount: 60000 }],
    });

    expect(rest.settledLoans).toEqual([loan.id]);

    outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding).toHaveLength(0);

    const { rows } = await pg.query<{ status: string }>(
      `SELECT status FROM creditos WHERE id = '${loan.id}'`,
    );

    expect(rows[0]!.status).toBe('paid');
  });

  it('rechaza un abono mayor al saldo pendiente', async () => {
    const loan = await createEmployeeLoanCredito(h.db, {
      organizationId: ORG,
      employeeId: EMP,
      employeeName: 'Juana Pérez',
      amount: 50000,
      cashMovementId: null,
      createdBy: 'Cajero',
    });
    const sessionId = await openSession();

    await expect(
      recordEmployeeLoanRepaymentCaja(h.db, {
        organizationId: ORG,
        sessionId,
        createdBy: 'Cajero',
        selections: [{ loanId: loan.id, amount: 60000 }],
      }),
    ).rejects.toThrow();
  });

  it('un crédito de cliente en la misma org se agrupa aparte y no se afecta', async () => {
    // Vale a empleado.
    await createEmployeeLoanCredito(h.db, {
      organizationId: ORG,
      employeeId: EMP,
      employeeName: 'Juana Pérez',
      amount: 100000,
      cashMovementId: null,
      createdBy: 'Cajero',
    });

    // Crédito de cliente (venta fiada) — customer_id NULL, identidad por notes.
    await createCredito(h.db, {
      organizationId: ORG,
      saleId: '00000000-0000-0000-0000-0000000000a1',
      originalAmount: 30000,
      dueDate: '2026-08-01',
      notes: 'Cliente: Pedro Gómez | Tel: 300',
    });

    const overview = await getCreditosOverview(ORG);

    const empGroup = overview.clients.find(c => c.clientKey === `emp:${EMP}`);
    const custGroup = overview.clients.find(c => c.isEmployee === false);

    expect(empGroup).toBeDefined();
    expect(empGroup!.isEmployee).toBe(true);
    expect(empGroup!.balance).toBe(100000);

    expect(custGroup).toBeDefined();
    expect(custGroup!.name).toBe('Pedro Gómez');
    expect(custGroup!.isEmployee).toBe(false);
    expect(custGroup!.balance).toBe(30000);

    // Dos grupos distintos: el empleado no contamina al cliente ni viceversa.
    expect(overview.clients).toHaveLength(2);
    expect(overview.metrics.clientsWithDebt).toBe(2);
  });
});
