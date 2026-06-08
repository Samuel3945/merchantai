'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { getAppSetting, setAppSetting } from '@/actions/app-settings';
import {
  DEFAULT_TERM_DAYS,
  extendFiadoTerm,
  getClientDetail,
  getFiadosHistory,
  getFiadosOverview,
  recordAbono,
  TERM_SETTING_KEY,
} from '@/libs/fiados';

// Thin auth + revalidate wrappers over the fiados core (libs/fiados.ts). All the
// money + ledger logic lives in the core so it can run inside sale transactions
// and be reasoned about without Clerk.

export type {
  ClientDebt,
  ClientDetail,
  FiadosMetrics,
  FiadosOverview,
  FiadoTimelineEntry,
} from '@/libs/fiados';

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

export async function fetchFiadosOverview() {
  const { orgId } = await requireOrg();
  return getFiadosOverview(orgId);
}

export async function fetchFiadosHistory() {
  const { orgId } = await requireOrg();
  return getFiadosHistory(orgId);
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

export async function abonarFiado(input: AbonarInput) {
  const { userId, orgId } = await requireOrg();
  const result = await recordAbono({
    organizationId: orgId,
    clientKey: input.clientKey,
    amount: input.amount,
    method: input.method,
    note: input.note ?? null,
    createdBy: userId,
  });
  revalidatePath('/dashboard/fiados');
  revalidatePath('/dashboard/cash');
  return result;
}

export type ExtenderPlazoInput = {
  fiadoId: string;
  newDueDate: string;
  reason?: string | null;
};

export async function extenderPlazo(input: ExtenderPlazoInput) {
  const { userId, orgId } = await requireOrg();
  const result = await extendFiadoTerm({
    organizationId: orgId,
    fiadoId: input.fiadoId,
    newDueDate: input.newDueDate,
    reason: input.reason ?? null,
    createdBy: userId,
  });
  revalidatePath('/dashboard/fiados');
  return result;
}

// ── Default term setting (Configuración) ─────────────────────────────────────

export async function getFiadoTermDays(): Promise<number> {
  const { value } = await getAppSetting(TERM_SETTING_KEY);
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TERM_DAYS;
}

export async function setFiadoTermDays(days: number): Promise<number> {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n < 1 || n > 365) {
    throw new Error('El plazo debe estar entre 1 y 365 días');
  }
  await setAppSetting(TERM_SETTING_KEY, String(n));
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/fiados');
  return n;
}
