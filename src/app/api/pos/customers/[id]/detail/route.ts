import { NextResponse } from 'next/server';
import { loadCustomerDetail } from '@/features/customers/customer-detail';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Customer detail (ficha de cliente) for the POS side panel. Cashier-auth via
// the shared POS guard; returns the SAME shape as the dashboard's
// getCustomerDetail action (both call loadCustomerDetail), org-scoped to the
// authenticated device/cashier's organization.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id es requerido' }, { status: 400 });
  }

  const detail = await loadCustomerDetail(ctx.organizationId, id);
  if (!detail) {
    return NextResponse.json(
      { error: 'Cliente no encontrado' },
      { status: 404 },
    );
  }

  return NextResponse.json(detail);
}
