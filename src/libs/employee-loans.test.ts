/**
 * Integración (PGlite) de los préstamos a empleados (vales):
 *  - crear un préstamo → aparece como pendiente
 *  - abono parcial → status 'partial', pendiente reducido
 *  - abono total → status 'paid', sale de la lista de pendientes
 */

import type * as EmployeeLoans from '@/libs/employee-loans';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Executor = Parameters<typeof EmployeeLoans.listOutstandingEmployeeLoans>[0];

const h = vi.hoisted(() => ({
  db: null as unknown as Executor,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

const { insertEmployeeLoan, listOutstandingEmployeeLoans, recordEmployeeLoanRepaymentCaja }
  = await import('@/libs/employee-loans');

const SETUP_SQL = `
  CREATE TYPE "employee_loan_status" AS ENUM('open', 'partial', 'paid');

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type text NOT NULL,
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

  CREATE TABLE employee_loans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    employee_id uuid NOT NULL,
    borrower_name text,
    total_amount numeric(12, 2) NOT NULL,
    paid_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    status "employee_loan_status" DEFAULT 'open' NOT NULL,
    cash_movement_id uuid,
    notes text,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE employee_loan_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    employee_id uuid NOT NULL,
    loan_id uuid,
    cash_movement_id uuid,
    treasury_movement_id uuid,
    amount numeric(12, 2) NOT NULL,
    note text,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-loans-test';
const EMP = '00000000-0000-0000-0000-0000000000e1';
const SESSION = '00000000-0000-0000-0000-0000000000f1';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg) as unknown as Executor;
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM employee_loan_payments');
  await pg.exec('DELETE FROM employee_loans');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM pos_users');
  await pg.exec(
    `INSERT INTO pos_users (id, organization_id, name) VALUES ('${EMP}', '${ORG}', 'Juana Pérez')`,
  );
});

async function createLoan(total: number): Promise<string> {
  const loan = await insertEmployeeLoan(h.db, {
    organizationId: ORG,
    employeeId: EMP,
    borrowerName: 'Juana Pérez',
    totalAmount: total,
    cashMovementId: null,
    createdBy: 'Cajero',
    notes: 'vale de prueba',
  });
  return loan.id;
}

describe('préstamos a empleados', () => {
  it('un préstamo creado aparece como pendiente con el nombre del empleado', async () => {
    await createLoan(100000);

    const outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.employeeName).toBe('Juana Pérez');
    expect(outstanding[0]!.totalAmount).toBe(100000);
    expect(outstanding[0]!.paidAmount).toBe(0);
    expect(outstanding[0]!.outstanding).toBe(100000);
  });

  it('un abono parcial deja el préstamo en partial y reduce el pendiente', async () => {
    const loanId = await createLoan(100000);

    const result = await recordEmployeeLoanRepaymentCaja(h.db, {
      organizationId: ORG,
      sessionId: SESSION,
      createdBy: 'Cajero',
      selections: [{ loanId, amount: 40000 }],
    });

    expect(result.appliedTotal).toBe(40000);
    expect(result.settledLoans).toEqual([]);

    const outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.paidAmount).toBe(40000);
    expect(outstanding[0]!.outstanding).toBe(60000);

    const { rows: loanRows } = await pg.query<{ status: string }>(
      `SELECT status FROM employee_loans WHERE id = '${loanId}'`,
    );

    expect(loanRows[0]!.status).toBe('partial');

    // The repayment inserted a deposit cash_movements row (cash INTO the drawer).
    const { rows: movRows } = await pg.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cash_movements WHERE type='deposit' AND amount='40000.00'`,
    );

    expect(movRows[0]!.n).toBe('1');
  });

  it('un abono total deja el préstamo en paid y lo saca de la lista de pendientes', async () => {
    const loanId = await createLoan(100000);

    const result = await recordEmployeeLoanRepaymentCaja(h.db, {
      organizationId: ORG,
      sessionId: SESSION,
      createdBy: 'Cajero',
      selections: [{ loanId, amount: 100000 }],
    });

    expect(result.appliedTotal).toBe(100000);
    expect(result.settledLoans).toEqual([loanId]);

    const outstanding = await listOutstandingEmployeeLoans(h.db, ORG);

    expect(outstanding).toHaveLength(0);

    const { rows } = await pg.query<{ status: string; paid: string }>(
      `SELECT status, paid_amount AS paid FROM employee_loans WHERE id = '${loanId}'`,
    );

    expect(rows[0]!.status).toBe('paid');
    expect(rows[0]!.paid).toBe('100000.00');
  });

  it('rechaza un abono mayor al saldo pendiente', async () => {
    const loanId = await createLoan(50000);

    await expect(
      recordEmployeeLoanRepaymentCaja(h.db, {
        organizationId: ORG,
        sessionId: SESSION,
        createdBy: 'Cajero',
        selections: [{ loanId, amount: 60000 }],
      }),
    ).rejects.toThrow();
  });
});
