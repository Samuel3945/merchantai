'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import {
  extendCreditoTerm,
  getClientDetail,
  getCreditosHistory,
  getCreditosOverview,
  recordAbono,
} from '@/libs/creditos';
import { requirePanelModule } from '@/libs/panel-session';

// Thin auth + revalidate wrappers over the creditos core (libs/creditos.ts). All the
// money + ledger logic lives in the core so it can run inside sale transactions
// and be reasoned about without Clerk.

export type {
  ClientDebt,
  ClientDetail,
  CreditosMetrics,
  CreditosOverview,
  CreditoTimelineEntry,
} from '@/libs/creditos';

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  // Backend enforcement: the owner passes; a member needs the Creditos module.
  await requirePanelModule('creditos');
  return { userId, orgId };
}

export async function fetchCreditosOverview() {
  const { orgId } = await requireOrg();
  return getCreditosOverview(orgId);
}

export async function fetchCreditosHistory() {
  const { orgId } = await requireOrg();
  return getCreditosHistory(orgId);
}

export async function fetchClientDetail(clientKey: string) {
  const { orgId } = await requireOrg();
  return getClientDetail(orgId, clientKey);
}

export type AbonarInput = {
  clientKey: string;
  amount: number | string;
  method: string;
  note?: string | null;
};

export async function abonarCredito(input: AbonarInput) {
  const { userId, orgId } = await requireOrg();
  const result = await recordAbono({
    organizationId: orgId,
    clientKey: input.clientKey,
    amount: input.amount,
    method: input.method,
    note: input.note ?? null,
    createdBy: userId,
  });
  revalidatePath('/dashboard/creditos');
  revalidatePath('/dashboard/cash');
  return result;
}

export type ExtenderPlazoInput = {
  creditoId: string;
  newDueDate: string;
  reason?: string | null;
};

export async function extenderPlazo(input: ExtenderPlazoInput) {
  const { userId, orgId } = await requireOrg();
  const result = await extendCreditoTerm({
    organizationId: orgId,
    creditoId: input.creditoId,
    newDueDate: input.newDueDate,
    reason: input.reason ?? null,
    createdBy: userId,
  });
  revalidatePath('/dashboard/creditos');
  return result;
}
