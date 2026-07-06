import type { db } from '@/libs/DB';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { round2 } from '@/libs/creditos-math';
import {
  cashMovementsSchema,
  employeeLoanPaymentsSchema,
  employeeLoansSchema,
  posUsersSchema,
} from '@/models/Schema';

// Bridges the pooled db and a tx handle (same pattern as cash-helpers.ts).
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── insertEmployeeLoan ────────────────────────────────────────────────────────
// Inserts ONE `open` loan header inside the caller's tx. Called from the POS
// movement route right after the funding `advance` cash_movements row is written,
// so cashMovementId links the loan to the drawer outflow that funded it.

export type InsertEmployeeLoanInput = {
  organizationId: string;
  employeeId: string;
  borrowerName: string | null;
  totalAmount: number;
  cashMovementId: string | null;
  createdBy: string;
  notes?: string | null;
};

export async function insertEmployeeLoan(
  tx: Executor,
  input: InsertEmployeeLoanInput,
): Promise<typeof employeeLoansSchema.$inferSelect> {
  const total = round2(input.totalAmount);
  if (!(total > 0)) {
    throw new Error('El monto del préstamo debe ser mayor a 0');
  }

  const [row] = await tx
    .insert(employeeLoansSchema)
    .values({
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      borrowerName: input.borrowerName,
      totalAmount: total.toFixed(2),
      paidAmount: '0',
      status: 'open',
      cashMovementId: input.cashMovementId,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('No se pudo registrar el préstamo');
  }
  return row;
}

// ── listOutstandingEmployeeLoans ──────────────────────────────────────────────
// Open/partial loans for the org, oldest-first, with the employee's live name
// resolved (falling back to the snapshot taken at creation). Read-only.

export type OutstandingEmployeeLoan = {
  loanId: string;
  employeeId: string;
  employeeName: string | null;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  createdAt: Date;
  notes: string | null;
};

export async function listOutstandingEmployeeLoans(
  executor: Executor,
  organizationId: string,
): Promise<OutstandingEmployeeLoan[]> {
  const rows = await executor
    .select({
      loanId: employeeLoansSchema.id,
      employeeId: employeeLoansSchema.employeeId,
      userName: posUsersSchema.name,
      borrowerName: employeeLoansSchema.borrowerName,
      totalAmount: employeeLoansSchema.totalAmount,
      paidAmount: employeeLoansSchema.paidAmount,
      createdAt: employeeLoansSchema.createdAt,
      notes: employeeLoansSchema.notes,
    })
    .from(employeeLoansSchema)
    .leftJoin(
      posUsersSchema,
      eq(posUsersSchema.id, employeeLoansSchema.employeeId),
    )
    .where(
      and(
        eq(employeeLoansSchema.organizationId, organizationId),
        inArray(employeeLoansSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(asc(employeeLoansSchema.createdAt));

  return rows.map((r: {
    loanId: string;
    employeeId: string;
    userName: string | null;
    borrowerName: string | null;
    totalAmount: string;
    paidAmount: string;
    createdAt: Date;
    notes: string | null;
  }) => {
    const total = round2(Number.parseFloat(r.totalAmount));
    const paid = round2(Number.parseFloat(r.paidAmount));
    return {
      loanId: r.loanId,
      employeeId: r.employeeId,
      employeeName: r.userName ?? r.borrowerName ?? null,
      totalAmount: total,
      paidAmount: paid,
      outstanding: round2(total - paid),
      createdAt: r.createdAt,
      notes: r.notes,
    };
  });
}

// ── recordEmployeeLoanRepaymentCaja ───────────────────────────────────────────
// Applies caller-chosen abonos to employee loans inside the caller's tx. For each
// selection: locks the loan FOR UPDATE (org-scoped), inserts a `deposit`
// cash_movements row (cash BACK into the drawer), inserts an
// employee_loan_payments ledger row, and recomputes paid_amount + status.
//
// Money DIRECTION vs supplier settle: a supplier payment is a drawer OUTFLOW
// (type='expense'); a loan repayment is a drawer INFLOW (type='deposit').

export type EmployeeLoanRepaymentSelection = {
  loanId: string;
  amount: number;
};

export type EmployeeLoanRepaymentInput = {
  organizationId: string;
  sessionId: string;
  createdBy: string;
  selections: EmployeeLoanRepaymentSelection[];
};

export type EmployeeLoanRepaymentResult = {
  appliedTotal: number;
  settledLoans: string[];
};

export async function recordEmployeeLoanRepaymentCaja(
  tx: Executor,
  input: EmployeeLoanRepaymentInput,
): Promise<EmployeeLoanRepaymentResult> {
  if (input.selections.length === 0) {
    throw new Error('No seleccionaste ningún préstamo');
  }

  // Reject duplicate loan ids — each chosen loan is paid exactly once.
  const ids = input.selections.map(s => s.loanId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Hay préstamos repetidos en la selección');
  }

  // Deterministic id-sorted order → consistent lock acquisition, no deadlock.
  const ordered = [...input.selections].sort((a, b) =>
    a.loanId.localeCompare(b.loanId),
  );

  let appliedTotal = 0;
  const settledLoans: string[] = [];

  for (const sel of ordered) {
    const amount = round2(sel.amount);
    if (!(amount > 0)) {
      throw new Error('El monto de cada abono debe ser mayor a 0');
    }

    // 1. Lock the loan FOR UPDATE (org-scoped).
    const [loan] = await tx
      .select({
        id: employeeLoansSchema.id,
        employeeId: employeeLoansSchema.employeeId,
        totalAmount: employeeLoansSchema.totalAmount,
        paidAmount: employeeLoansSchema.paidAmount,
        status: employeeLoansSchema.status,
      })
      .from(employeeLoansSchema)
      .where(
        and(
          eq(employeeLoansSchema.id, sel.loanId),
          eq(employeeLoansSchema.organizationId, input.organizationId),
        ),
      )
      .for('update')
      .limit(1);

    if (!loan) {
      throw new Error(
        'El préstamo seleccionado no existe o no pertenece a esta organización',
      );
    }
    if (loan.status === 'paid') {
      throw new Error('Ese préstamo ya está saldado — no acepta más abonos');
    }

    const total = round2(Number.parseFloat(loan.totalAmount));
    const alreadyPaid = round2(Number.parseFloat(loan.paidAmount));
    const outstanding = round2(total - alreadyPaid);

    if (amount > outstanding + 0.005) {
      throw new Error(
        `El abono ($${amount.toFixed(2)}) supera el saldo del préstamo ($${outstanding.toFixed(2)})`,
      );
    }

    // 2. Insert the deposit cash_movements row — cash INTO the drawer.
    const [movRow] = await tx
      .insert(cashMovementsSchema)
      .values({
        sessionId: input.sessionId,
        organizationId: input.organizationId,
        type: 'deposit',
        amount: amount.toFixed(2),
        reason: 'Abono de préstamo de empleado',
        category: null,
        createdBy: input.createdBy,
      })
      .returning({ id: cashMovementsSchema.id });

    if (!movRow) {
      throw new Error(
        'recordEmployeeLoanRepaymentCaja: no se pudo registrar el movimiento de caja',
      );
    }

    // 3. Insert the employee_loan_payments ledger row.
    await tx.insert(employeeLoanPaymentsSchema).values({
      organizationId: input.organizationId,
      employeeId: loan.employeeId,
      loanId: loan.id,
      cashMovementId: movRow.id,
      treasuryMovementId: null,
      amount: amount.toFixed(2),
      note: null,
      createdBy: input.createdBy,
    });

    // 4. Recompute paid_amount + status.
    const newPaid = round2(alreadyPaid + amount);
    const newStatus: 'open' | 'partial' | 'paid'
      = newPaid >= total - 0.005 ? 'paid' : 'partial';

    await tx
      .update(employeeLoansSchema)
      .set({ paidAmount: newPaid.toFixed(2), status: newStatus })
      .where(eq(employeeLoansSchema.id, loan.id));

    appliedTotal = round2(appliedTotal + amount);
    if (newStatus === 'paid') {
      settledLoans.push(loan.id);
    }
  }

  return { appliedTotal, settledLoans };
}
