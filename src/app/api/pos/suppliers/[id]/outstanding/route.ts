// GET /api/pos/suppliers/:id/outstanding
// Returns the total outstanding balance owed to a supplier across all open/partial
// payables for the caja's org. Used by the device before recording a payment to
// decide whether to show the "settle invoice" or "generic gasto" UX.
//
// Auth: requirePosAuth (mirrors /api/pos/suppliers/route.ts pattern).
// Read-only; no locks acquired.

import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { getSupplierOutstanding } from '@/libs/supplier-invoice-payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const { id: supplierId } = await params;
  if (!supplierId) {
    return NextResponse.json({ error: 'supplierId requerido' }, { status: 400 });
  }

  try {
    const result = await getSupplierOutstanding(db, ctx.organizationId, supplierId);

    return NextResponse.json({
      supplierId,
      totalOutstanding: result.totalOutstanding,
      invoiceCount: result.invoiceCount,
      invoices: result.invoices.map(inv => ({
        payableId: inv.payableId,
        outstanding: inv.outstanding,
        status: inv.status,
        // Etiqueta para que el cajero reconozca la factura (número + fecha).
        invoiceNumber: inv.invoiceNumber,
        purchasedAt: inv.purchasedAt,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al obtener saldo pendiente' },
      { status: 500 },
    );
  }
}
