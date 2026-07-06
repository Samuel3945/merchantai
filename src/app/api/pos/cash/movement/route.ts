import type { CashMovementType } from '@/libs/cash-helpers';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import {
  EXPENSE_MOVEMENT_TYPES,
  findOpenSession,
  INCOME_MOVEMENT_TYPES,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  insertEmployeeLoan,
  recordEmployeeLoanRepaymentCaja,
} from '@/libs/employee-loans';
import { requirePosAuth } from '@/libs/pos-auth';
import { recordPosGastoBridge } from '@/libs/pos-gasto-bridge';
import {
  getSupplierOutstanding,
  recordSelectedPayablesPayment,
  recordSupplierPayment,
} from '@/libs/supplier-invoice-payment';
import { recordInflowSourceDebit } from '@/libs/treasury';
import {
  appSettingsSchema,
  cashMovementsSchema,
  posUsersSchema,
  suppliersSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Origin discriminator for entrada (inflow) movements.
// 'internal': cash from another treasury container (cofre, banco).
//             Requires fromAccountId. Records a companion treasury salida.
// 'external': direct owner injection — no source container.
// Omitted / null: legacy device — treated as a plain cash entrada (backward-compat).
type InternalOrigin = {
  kind: 'internal';
  fromAccountId?: string;
};

type ExternalOrigin = {
  kind: 'external';
};

type MovementBody = {
  type?: string;
  amount?: number | string;
  reason?: string;
  // Optional: links a "Pago a proveedor" movement to a supplier. The device
  // sends the supplier id chosen from /pos/suppliers; it is validated against
  // the caja's org before being persisted to cash_movements.supplier_id.
  supplierId?: string | null;
  // Optional: device-chosen invoices to settle (full or partial each). When sent
  // on a type='expense' + supplierId payment, settles EXACTLY these payables
  // instead of auto-allocating `amount` oldest-first. Omitted → legacy oldest-first.
  payableSelections?: { payableId?: string; amount?: number | string }[] | null;
  // Optional (slice 3): origin discriminator for entrada movements.
  // Legacy devices that omit this field keep working unchanged (backward-compat).
  origin?: InternalOrigin | ExternalOrigin | null;
  // Employee loans (vale / préstamo). On a salida type='advance' with
  // loanKind='employee_loan', creates a loan for `employeeId` funded by the
  // advance. Requires the modules.employee_loans toggle to be ON.
  employeeId?: string | null;
  loanKind?: 'employee_loan' | null;
  // On an entrada type='deposit', settles EXACTLY these loans (abonos). Always
  // allowed, even when the toggle is OFF, so outstanding loans can be repaid.
  loanSelections?: { loanId?: string; amount?: number | string }[] | null;
};

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TYPES: CashMovementType[] = [
  ...INCOME_MOVEMENT_TYPES,
  ...EXPENSE_MOVEMENT_TYPES,
];

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: MovementBody;
  try {
    body = (await req.json()) as MovementBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const type = body.type as CashMovementType | undefined;
  if (!type || !ALLOWED_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `Tipo de movimiento inválido: ${body.type}` },
      { status: 400 },
    );
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json(
      { error: 'reason es requerido' },
      { status: 400 },
    );
  }

  // Parse optional device-chosen invoice selections. Each entry must be a
  // non-empty payableId with a positive amount; an invalid shape is rejected
  // outright so the settle path never receives a malformed selection.
  let selections: { payableId: string; amount: number }[] | null = null;
  if (body.payableSelections != null) {
    if (!Array.isArray(body.payableSelections) || body.payableSelections.length === 0) {
      return NextResponse.json(
        { error: 'payableSelections debe ser una lista no vacía' },
        { status: 400 },
      );
    }
    const parsed: { payableId: string; amount: number }[] = [];
    for (const s of body.payableSelections) {
      const pid = typeof s?.payableId === 'string' ? s.payableId.trim() : '';
      const amt = Number.parseFloat(toMoney(s?.amount ?? 0));
      if (!pid || !(amt > 0)) {
        return NextResponse.json(
          { error: 'Cada factura seleccionada necesita un id y un monto mayor a 0' },
          { status: 400 },
        );
      }
      parsed.push({ payableId: pid, amount: amt });
    }
    selections = parsed;
  }

  // Parse optional device-chosen loan selections (abonos). Same shape/validation
  // as payableSelections: each entry needs a loanId and a positive amount.
  let loanSelections: { loanId: string; amount: number }[] | null = null;
  if (body.loanSelections != null) {
    if (!Array.isArray(body.loanSelections) || body.loanSelections.length === 0) {
      return NextResponse.json(
        { error: 'loanSelections debe ser una lista no vacía' },
        { status: 400 },
      );
    }
    const parsed: { loanId: string; amount: number }[] = [];
    for (const s of body.loanSelections) {
      const lid = typeof s?.loanId === 'string' ? s.loanId.trim() : '';
      const amt = Number.parseFloat(toMoney(s?.amount ?? 0));
      if (!lid || !(amt > 0)) {
        return NextResponse.json(
          { error: 'Cada préstamo seleccionado necesita un id y un monto mayor a 0' },
          { status: 400 },
        );
      }
      parsed.push({ loanId: lid, amount: amt });
    }
    loanSelections = parsed;
  }

  // A selection-driven supplier settle defines its own total (sum of the chosen
  // lines), so `amount` is optional there. Every other movement still needs amount.
  const settleViaSelections
    = selections != null && type === 'expense' && !!body.supplierId;

  // A loan repayment defines its own total (sum of the chosen abonos), so `amount`
  // is optional there too.
  const repayViaLoanSelections = loanSelections != null && type === 'deposit';

  const amount = toMoney(body.amount ?? 0);
  if (
    !settleViaSelections
    && !repayViaLoanSelections
    && Number.parseFloat(amount) <= 0
  ) {
    return NextResponse.json(
      { error: 'amount debe ser > 0' },
      { status: 400 },
    );
  }

  // Validate origin when provided on income movement types.
  const isIncome = INCOME_MOVEMENT_TYPES.includes(type);
  const origin = body.origin ?? null;

  if (origin && origin.kind === 'internal') {
    if (!isIncome) {
      return NextResponse.json(
        { error: 'origin solo es válido para movimientos de ingreso (entrada)' },
        { status: 400 },
      );
    }
    if (!origin.fromAccountId) {
      return NextResponse.json(
        { error: 'origin.fromAccountId es requerido para origin.kind="internal"' },
        { status: 400 },
      );
    }
  }

  if (origin && origin.kind === 'external' && !isIncome) {
    return NextResponse.json(
      { error: 'origin solo es válido para movimientos de ingreso (entrada)' },
      { status: 400 },
    );
  }

  // Optional supplier link (Pago a proveedor). Must be a real, active supplier
  // of this caja's org — guards against stale or cross-tenant ids from the device.
  const supplierId = body.supplierId ?? null;
  if (supplierId) {
    const [supplier] = await db
      .select({ id: suppliersSchema.id })
      .from(suppliersSchema)
      .where(
        and(
          eq(suppliersSchema.id, supplierId),
          eq(suppliersSchema.organizationId, ctx.organizationId),
          eq(suppliersSchema.status, 'active'),
        ),
      )
      .limit(1);
    if (!supplier) {
      return NextResponse.json(
        { error: 'El proveedor seleccionado no existe o está archivado' },
        { status: 400 },
      );
    }
  }

  // Employee-loan CREATION guardrails (checked before opening the tx):
  //   1. the org must have the modules.employee_loans toggle ON;
  //   2. employeeId must be a real, active pos_user of this org.
  // The borrower name is snapshotted at creation.
  const isLoanCreation = type === 'advance' && body.loanKind === 'employee_loan';
  let loanEmployeeId = '';
  let loanBorrowerName: string | null = null;
  if (isLoanCreation) {
    const [setting] = await db
      .select({ value: appSettingsSchema.value })
      .from(appSettingsSchema)
      .where(
        and(
          eq(appSettingsSchema.organizationId, ctx.organizationId),
          eq(appSettingsSchema.key, 'modules.employee_loans'),
        ),
      )
      .limit(1);
    if (setting?.value !== 'true') {
      return NextResponse.json(
        { error: 'Los vales/préstamos a empleados están desactivados' },
        { status: 403 },
      );
    }

    loanEmployeeId
      = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
    if (!loanEmployeeId || !UUID_RE.test(loanEmployeeId)) {
      return NextResponse.json(
        { error: 'Seleccioná un empleado válido para el vale' },
        { status: 400 },
      );
    }
    const [emp] = await db
      .select({ id: posUsersSchema.id, name: posUsersSchema.name })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.id, loanEmployeeId),
          eq(posUsersSchema.organizationId, ctx.organizationId),
          eq(posUsersSchema.active, true),
        ),
      )
      .limit(1);
    if (!emp) {
      return NextResponse.json(
        { error: 'El empleado seleccionado no existe o está inactivo' },
        { status: 400 },
      );
    }
    loanBorrowerName = emp.name;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
      if (!open) {
        throw new Error('No hay caja abierta. Abre la caja primero.');
      }

      // EMPLOYEE-LOAN REPAYMENT — an entrada that pays down existing loans. The
      // lib inserts its own deposit cash_movements rows, so we do NOT also insert
      // a generic deposit here. Always allowed (even when the toggle is OFF).
      if (repayViaLoanSelections && loanSelections) {
        const repay = await recordEmployeeLoanRepaymentCaja(tx, {
          organizationId: ctx.organizationId,
          sessionId: open.id,
          createdBy: ctx.cashierName || 'Cajero',
          selections: loanSelections,
        });

        await logAction({
          organizationId: ctx.organizationId,
          actor: resolvePosActor(ctx),
          action: 'pos.employee_loan.repaid',
          entityType: 'employee_loan_payment',
          entityId: loanSelections[0]!.loanId,
          after: {
            appliedTotal: repay.appliedTotal,
            settledLoans: repay.settledLoans,
            loanCount: loanSelections.length,
          },
          metadata: { cashierName: ctx.cashierName, sessionId: open.id },
          ip:
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')
            || null,
          userAgent: req.headers.get('user-agent'),
        });

        return {
          kind: 'loan_repaid' as const,
          appliedTotal: repay.appliedTotal,
          settledLoans: repay.settledLoans,
        };
      }

      // For INTERNAL-origin entradas: record a treasury salida from the source
      // container BEFORE inserting the cash_movements row. This validates the
      // source (active, org-scoped, sufficient balance) inside the transaction,
      // so any validation failure rolls back both writes atomically.
      let treasuryMovementId: string | null = null;

      if (origin?.kind === 'internal' && origin.fromAccountId) {
        const treasuryRow = await recordInflowSourceDebit(tx, {
          organizationId: ctx.organizationId,
          fromAccountId: origin.fromAccountId,
          amount,
          reason,
          createdBy: ctx.cashierName || 'Cajero',
        });
        treasuryMovementId = treasuryRow.id;
      }

      // gasto-treasury-unification + supplier-payment-unify:
      // When type='expense' with a supplierId that has outstanding debt → SETTLE
      //   (recordSupplierPayment with caja funding — no expenses row, no P&L).
      // When type='expense' with no debt or no supplierId → GASTO BRIDGE
      //   (recordPosGastoBridge — dual-write expenses + cash_movements, P&L anchor).
      // All other types keep the plain insert.
      let created: typeof cashMovementsSchema.$inferSelect | undefined;
      // Extra settle metadata returned in response (undefined for non-settle paths).
      let settleOutcome: { outcome: 'settled'; appliedTotal: number; settledPayables: number } | undefined;
      // Extra loan-creation metadata (undefined unless a vale was created).
      let loanOutcome: { outcome: 'loan_created'; loanId: string } | undefined;

      if (type === 'expense' && supplierId) {
        // Check whether this supplier has outstanding payables inside the tx.
        const outstanding = await getSupplierOutstanding(
          tx,
          ctx.organizationId,
          supplierId,
        );

        if (outstanding.totalOutstanding > 0) {
          // SETTLE PATH — caja-funded, no P&L, no expenses row.
          let settleResult;
          if (settleViaSelections && selections) {
            // Pay EXACTLY the device-chosen invoices (full or partial each). The
            // primitive caps each line at its own outstanding under FOR UPDATE and
            // settles all-or-nothing.
            settleResult = await recordSelectedPayablesPayment(tx, {
              organizationId: ctx.organizationId,
              supplierId,
              fundingSource: { kind: 'caja', sessionId: open.id },
              selections,
              createdBy: ctx.cashierName || 'Cajero',
              note: reason,
            });
          } else {
            const amtNum = Number.parseFloat(amount);

            // Pre-check: reject overpay before entering the write path.
            // Gives a clear Spanish message; the primitive also throws as a guard.
            if (amtNum > outstanding.totalOutstanding + 0.005) {
              throw new Error(
                `El monto ($${amtNum.toFixed(2)}) supera la deuda del proveedor ($${outstanding.totalOutstanding.toFixed(2)}). Reducí el monto o registralo como gasto aparte.`,
              );
            }

            settleResult = await recordSupplierPayment(tx, {
              organizationId: ctx.organizationId,
              supplierId,
              fundingSource: { kind: 'caja', sessionId: open.id },
              amount: amtNum,
              createdBy: ctx.cashierName || 'Cajero',
              note: reason,
            });
          }

          // Use the cashMovementId threaded back from the last chunk — avoids
          // a heuristic re-query that could return a cross-payment row (oldest).
          const lastChunk = settleResult.breakdown[settleResult.breakdown.length - 1];
          if (lastChunk?.cashMovementId) {
            const [row] = await tx
              .select()
              .from(cashMovementsSchema)
              .where(eq(cashMovementsSchema.id, lastChunk.cashMovementId))
              .limit(1);
            created = row;
          }

          settleOutcome = {
            outcome: 'settled',
            appliedTotal: settleResult.appliedTotal,
            settledPayables: settleResult.breakdown.length,
          };

          await logAction({
            organizationId: ctx.organizationId,
            actor: resolvePosActor(ctx),
            action: 'pos.supplier.settled',
            entityType: 'supplier_payment',
            entityId: supplierId,
            after: {
              supplierId,
              amount,
              appliedTotal: settleResult.appliedTotal,
              settledPayables: settleResult.breakdown.length,
            },
            metadata: { cashierName: ctx.cashierName, sessionId: open.id },
            ip:
              req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
              || req.headers.get('x-real-ip')
              || null,
            userAgent: req.headers.get('user-agent'),
          });
        } else {
          // GASTO BRIDGE — supplier has no debt; treat as plain expense.
          const bridge = await recordPosGastoBridge(tx, {
            organizationId: ctx.organizationId,
            sessionId: open.id,
            amount,
            reason,
            supplierId,
            createdBy: ctx.cashierName || 'Cajero',
          });
          const [row] = await tx
            .select()
            .from(cashMovementsSchema)
            .where(eq(cashMovementsSchema.id, bridge.movementId))
            .limit(1);
          created = row;

          await logAction({
            organizationId: ctx.organizationId,
            actor: resolvePosActor(ctx),
            action: 'pos.gasto.bridged',
            entityType: 'expense',
            entityId: bridge.expenseId,
            after: {
              expenseId: bridge.expenseId,
              movementId: bridge.movementId,
              amount,
              reason,
            },
            metadata: { cashierName: ctx.cashierName, sessionId: open.id },
            ip:
              req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
              || req.headers.get('x-real-ip')
              || null,
            userAgent: req.headers.get('user-agent'),
          });
        }
      } else if (type === 'expense') {
        // GASTO BRIDGE — no supplier link; standard P&L expense.
        const bridge = await recordPosGastoBridge(tx, {
          organizationId: ctx.organizationId,
          sessionId: open.id,
          amount,
          reason,
          supplierId,
          createdBy: ctx.cashierName || 'Cajero',
        });

        // Fetch the full cash_movements row to return to the device (201 body).
        const [row] = await tx
          .select()
          .from(cashMovementsSchema)
          .where(eq(cashMovementsSchema.id, bridge.movementId))
          .limit(1);
        created = row;

        // Audit: log that a POS gasto was bridged to the P&L expenses table.
        await logAction({
          organizationId: ctx.organizationId,
          actor: resolvePosActor(ctx),
          action: 'pos.gasto.bridged',
          entityType: 'expense',
          entityId: bridge.expenseId,
          after: {
            expenseId: bridge.expenseId,
            movementId: bridge.movementId,
            amount,
            reason,
          },
          metadata: { cashierName: ctx.cashierName, sessionId: open.id },
          ip:
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')
            || null,
          userAgent: req.headers.get('user-agent'),
        });
      } else if (isLoanCreation) {
        // EMPLOYEE-LOAN CREATION — the advance salida funds a new loan. Both the
        // advance movement and the loan header are written in this one tx.
        const [row] = await tx
          .insert(cashMovementsSchema)
          .values({
            sessionId: open.id,
            organizationId: ctx.organizationId,
            type,
            amount,
            reason,
            createdBy: ctx.cashierName || 'Cajero',
          })
          .returning();
        created = row;
        if (!created) {
          throw new Error('No se pudo registrar el vale');
        }

        const loan = await insertEmployeeLoan(tx, {
          organizationId: ctx.organizationId,
          employeeId: loanEmployeeId,
          borrowerName: loanBorrowerName,
          totalAmount: Number.parseFloat(amount),
          cashMovementId: created.id,
          createdBy: ctx.cashierName || 'Cajero',
          notes: reason,
        });
        loanOutcome = { outcome: 'loan_created', loanId: loan.id };

        await logAction({
          organizationId: ctx.organizationId,
          actor: resolvePosActor(ctx),
          action: 'pos.employee_loan.created',
          entityType: 'employee_loan',
          entityId: loan.id,
          after: {
            loanId: loan.id,
            employeeId: loanEmployeeId,
            amount,
          },
          metadata: { cashierName: ctx.cashierName, sessionId: open.id },
          ip:
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')
            || null,
          userAgent: req.headers.get('user-agent'),
        });
      } else {
        const [row] = await tx
          .insert(cashMovementsSchema)
          .values({
            sessionId: open.id,
            organizationId: ctx.organizationId,
            type,
            amount,
            reason,
            supplierId,
            createdBy: ctx.cashierName || 'Cajero',
            // Slice 3: persist origin discriminator + treasury link for internal entradas
            origin: origin?.kind ?? null,
            treasuryMovementId,
          })
          .returning();
        created = row;
      }

      if (!created) {
        throw new Error('No se pudo registrar el movimiento');
      }
      return {
        kind: 'movement' as const,
        movement: created,
        settle: settleOutcome,
        loan: loanOutcome,
      };
    });

    // Response contract: a loan repayment returns its own outcome shape.
    if (result.kind === 'loan_repaid') {
      return NextResponse.json(
        {
          outcome: 'loan_repaid',
          appliedTotal: result.appliedTotal,
          settledLoans: result.settledLoans,
        },
        { status: 201 },
      );
    }
    // Includes settle metadata when outcome='settled'.
    if (result.settle) {
      return NextResponse.json(
        { ...result.movement, ...result.settle },
        { status: 201 },
      );
    }
    // Includes loan metadata when a vale was created.
    if (result.loan) {
      return NextResponse.json(
        { ...result.movement, ...result.loan },
        { status: 201 },
      );
    }
    return NextResponse.json({ ...result.movement, outcome: 'gasto' }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al registrar movimiento',
      },
      { status: 400 },
    );
  }
}
