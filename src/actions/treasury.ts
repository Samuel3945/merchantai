'use server';

import type { TreasuryAccount } from '@/libs/treasury';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import { getTreasuryPosition } from '@/libs/treasury';

// Read-only treasury position for the owner. Gated by the Caja module (owner
// passes). Phase 1: derived from existing data, no writes.
export async function getTreasury(): Promise<TreasuryAccount[]> {
  const { orgId } = await requirePanelModule('cash');
  return getTreasuryPosition(db, orgId);
}
