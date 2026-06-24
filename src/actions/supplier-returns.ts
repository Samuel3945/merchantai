'use server';

import type { ReturnLotResult } from '@/libs/supplier-refunds';
import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/db-context';
import { requirePanelModule } from '@/libs/panel-session';
import { returnLot as returnLotLib } from '@/libs/supplier-refunds';

const INVENTORY_PATH = '/dashboard/inventory';

// ── returnLot ─────────────────────────────────────────────────────────────────
//
// Server action: executes a lot-level supplier return in a single transaction.
// Gated by requirePanelModule('inventory').
//
// Input validation:
//   - qtyReturned must be > 0
//   - refundContainerId is required when the computed refundPortion > 0 (the lib
//     enforces this inside the tx with fresh outstanding values)
//
// The lib function (returnLot) enforces:
//   - qty ≤ lot.remainingQty (throws qty_exceeds_remaining)
//   - container present when refund > 0 (throws refund_container_required)
//
// After success: revalidates the inventory path so the UI refreshes.

export type ReturnLotInput = {
  lotId: string;
  qtyReturned: number;
  refundContainerId?: string | null;
  note?: string | null;
};

export async function returnLot(
  input: ReturnLotInput,
): Promise<ReturnLotResult> {
  const { orgId } = await requirePanelModule('inventory');
  const { userId } = await auth();

  if (!userId) {
    throw new Error('Not authenticated');
  }

  if (!input.lotId) {
    throw new Error('lotId is required');
  }

  if (!Number.isFinite(input.qtyReturned) || input.qtyReturned <= 0) {
    throw new Error('qtyReturned must be a positive number');
  }

  const tdb = await db();

  const result = await tdb.transaction(async (tx) => {
    return returnLotLib(tx, {
      organizationId: orgId,
      lotId: input.lotId,
      qtyReturned: input.qtyReturned,
      refundContainerId: input.refundContainerId ?? null,
      createdBy: userId,
      note: input.note ?? null,
    });
  });

  revalidatePath(INVENTORY_PATH);

  return result;
}
