import { and, eq, gte, ne, sql } from 'drizzle-orm';
import {
  supplierPayablesSchema,
  supplierPaymentsSchema,
} from '@/models/Schema';

// Executor is typed as `any` to bridge three compatible-but-structurally-distinct
// types: the plain Drizzle db (PGlite tests), the Drizzle tx handle, and the
// TenantDb / TenantDb-tx (production, from db-context). TenantInsert vs
// RawDb['insert'] differ in generic resolution but are runtime-identical.
// All exported function signatures are explicit, so call sites are type-checked.
// biome-ignore lint/suspicious/noExplicitAny: bridges Drizzle db/tx/TenantDb structural mismatch
type Executor = any;

// ── insertPurchasePayable ─────────────────────────────────────────────────────
// Creates exactly one open supplier_payables row for a purchase entry.
// Called INSIDE the existing recordMovement tdb.transaction (after the
// stock_movements insert, before commit) when reason === 'purchase'.
// totalAmount = qty × unitCost (frozen; never recomputed retroactively — REQ-7.2).
//
// return_supplier does not mutate payables — deferred; see REQ-7.1.

export type InsertPurchasePayableInput = {
  organizationId: string;
  supplierId: string;
  stockMovementId: string;
  qty: number;
  unitCost: string | number;
  createdBy: string;
  notes?: string | null;
  /** Optional invoice header (migration 0069). NULL = standalone purchase. */
  purchaseId?: string | null;
};

export type SupplierPayableRow
  = typeof supplierPayablesSchema.$inferSelect;

export async function insertPurchasePayable(
  executor: Executor,
  input: InsertPurchasePayableInput,
): Promise<SupplierPayableRow> {
  const totalAmount = (input.qty * Number(input.unitCost)).toFixed(2);

  const [row] = await executor
    .insert(supplierPayablesSchema)
    .values({
      organizationId: input.organizationId,
      supplierId: input.supplierId,
      stockMovementId: input.stockMovementId,
      totalAmount,
      paidAmount: '0',
      status: 'open',
      purchasedAt: new Date(),
      // Invoice grouping (migration 0069): stamp purchase_id when provided.
      purchaseId: input.purchaseId ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to insert supplier_payables row');
  }

  return row;
}

// ── getSupplierKpisForOrg ─────────────────────────────────────────────────────
// Pure KPI queries for supplier financials. Both values are org-scoped and
// return '0' (not null) when no data exists (REQ-5.4).
//
// paidThisMonth: SUM(supplier_payments.amount) WHERE created_at in current month.
//   Reads supplier_payments ONLY — not cash_movements (REQ-5.1, D6).
//   POS cashier "Pago a proveedor" gastos stay in expenses/P&L, not here.
//
// pendingPayments: SUM(total_amount − paid_amount) for open+partial payables (REQ-5.2).
//   Excludes status='paid' rows (SC-4.4).

export type SupplierKpiResult = {
  paidThisMonth: string;
  pendingPayments: string;
};

export async function getSupplierKpisForOrg(
  executor: Executor,
  organizationId: string,
): Promise<SupplierKpiResult> {
  const [paidRow] = await executor
    .select({
      total: sql<string>`COALESCE(SUM(${supplierPaymentsSchema.amount}), 0)::text`,
    })
    .from(supplierPaymentsSchema)
    .where(
      and(
        eq(supplierPaymentsSchema.organizationId, organizationId),
        gte(
          supplierPaymentsSchema.createdAt,
          sql`date_trunc('month', now() AT TIME ZONE 'America/Bogota')`,
        ),
      ),
    );

  // outstanding = total − paid − credited (migration 0068: credited_amount added).
  const [pendingRow] = await executor
    .select({
      total: sql<string>`COALESCE(SUM(${supplierPayablesSchema.totalAmount} - ${supplierPayablesSchema.paidAmount} - ${supplierPayablesSchema.creditedAmount}), 0)::text`,
    })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        ne(supplierPayablesSchema.status, 'paid'),
      ),
    );

  return {
    paidThisMonth: paidRow?.total ?? '0',
    pendingPayments: pendingRow?.total ?? '0',
  };
}
