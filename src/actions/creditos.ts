'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { getAppSetting, setAppSetting } from '@/actions/app-settings';
import {
  DEFAULT_TERM_DAYS,
  extendCreditoTerm,
  getClientDetail,
  getCreditosHistory,
  getCreditosOverview,
  recordAbono,
  TERM_SETTING_KEY,
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

// ── Default term setting (Configuración) ─────────────────────────────────────

export async function getCreditoTermDays(): Promise<number> {
  const { value } = await getAppSetting(TERM_SETTING_KEY);
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TERM_DAYS;
}

export async function setCreditoTermDays(days: number): Promise<number> {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n < 1 || n > 365) {
    throw new Error('El plazo debe estar entre 1 y 365 días');
  }
  await setAppSetting(TERM_SETTING_KEY, String(n));
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/creditos');
  return n;
}
