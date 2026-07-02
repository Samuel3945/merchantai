'use server';

import type { ActionResult } from '@/libs/action-result';
import type { TopUpPackage } from '@/libs/topup-catalog';
import { revalidatePath } from 'next/cache';
import * as z from 'zod';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  getGlobalSetting,
  PLATFORM_GLOBAL_ORG_ID,
} from '@/libs/platform/global-settings';
import { requirePlatformOperator } from '@/libs/platform/operator';
import { DEFAULT_TOPUP_PACKAGES } from '@/libs/topup-catalog';
import { appSettingsSchema } from '@/models/Schema';

/**
 * Operator-editable AI-credit top-up prices (the pricing behind
 * /platform/creditos and the tenant-facing top-up modal). Stored as JSON
 * under the platform-global app_settings key so no migration is needed —
 * same pattern as setOnboardingForced (platform-orgs.ts).
 */

const TOPUP_PACKAGES_KEY = 'topup_packages';

const storedPackageSchema = z.object({
  requests: z.number().int().positive(),
  amountCop: z.number().min(0),
});

const storedPackagesSchema = z.array(storedPackageSchema).min(1);

function withDerivedIds(
  packages: { requests: number; amountCop: number }[],
): TopUpPackage[] {
  return packages.map(p => ({ id: `credits_${p.requests}`, ...p }));
}

// No auth (mirrors getGlobalSetting): this feeds the tenant checkout flow, so
// it must never throw — any missing/malformed/invalid stored value silently
// falls back to the hardcoded defaults instead of breaking top-ups.
export async function getTopUpPackages(): Promise<TopUpPackage[]> {
  const raw = await getGlobalSetting(TOPUP_PACKAGES_KEY);
  if (!raw) {
    return DEFAULT_TOPUP_PACKAGES;
  }

  try {
    const parsed = storedPackagesSchema.parse(JSON.parse(raw));
    return withDerivedIds(parsed);
  } catch {
    return DEFAULT_TOPUP_PACKAGES;
  }
}

export type TopUpPackageInput = {
  requests: number;
  amountCop: number;
};

export async function setTopUpPackages(
  packages: TopUpPackageInput[],
): Promise<ActionResult<TopUpPackage[]>> {
  const operator = await requirePlatformOperator();

  if (packages.length === 0) {
    return { ok: false, error: 'Debe existir al menos un paquete de créditos' };
  }
  for (const pkg of packages) {
    if (!Number.isInteger(pkg.requests) || pkg.requests <= 0) {
      return { ok: false, error: 'Las consultas deben ser un entero mayor a 0' };
    }
    if (!Number.isFinite(pkg.amountCop) || pkg.amountCop < 0) {
      return { ok: false, error: 'El precio debe ser un número mayor o igual a 0' };
    }
  }
  const uniqueRequests = new Set(packages.map(p => p.requests));
  if (uniqueRequests.size !== packages.length) {
    return {
      ok: false,
      error: 'No puede haber dos paquetes con la misma cantidad de consultas',
    };
  }

  const normalized = withDerivedIds(
    packages.map(p => ({ requests: p.requests, amountCop: p.amountCop })),
  );
  const value = JSON.stringify(normalized);

  await db
    .insert(appSettingsSchema)
    .values({
      organizationId: PLATFORM_GLOBAL_ORG_ID,
      key: TOPUP_PACKAGES_KEY,
      value,
    })
    .onConflictDoUpdate({
      target: [appSettingsSchema.organizationId, appSettingsSchema.key],
      set: { value },
    });

  await logAction({
    organizationId: 'platform',
    actor: { type: 'user', id: operator.userId },
    action: 'platform.topup_packages_set',
    entityType: 'topup_packages',
    entityId: 'global',
    after: { packages: normalized },
  });

  revalidatePath('/platform/creditos');
  revalidatePath('/dashboard/plans');

  return { ok: true, data: normalized };
}
