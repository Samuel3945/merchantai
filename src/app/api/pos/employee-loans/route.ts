import { NextResponse } from 'next/server';
import { listOutstandingEmployeeLoans } from '@/libs/creditos';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Open/partial employee loans (vales) for the cashier's org. The device shows
// these so the cashier can register an abono (repayment) from Caja → Entrada.
// Read-only. Repayment happens via POST /pos/cash/movement with loanSelections.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const rows = await listOutstandingEmployeeLoans(db, ctx.organizationId);

  const loans = rows.map(r => ({
    loanId: r.loanId,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    totalAmount: r.totalAmount,
    outstanding: r.outstanding,
    createdAt: r.createdAt.toISOString(),
    notes: r.notes,
  }));

  return NextResponse.json({ loans });
}
