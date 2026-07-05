'use server';

import type { CourierWalletBalance } from '@/libs/courier-wallet';
import { auth } from '@clerk/nextjs/server';
import { listActiveCourierWalletBalances } from '@/libs/courier-wallet';

// Saldo "en la calle" de cada domiciliario activo. Alimenta el bolsillo de
// domiciliarios en Tesorería (que solo aparece si esta lista no está vacía).
export async function getCourierWalletsAction(): Promise<CourierWalletBalance[]> {
  const { orgId } = await auth();
  if (!orgId) {
    return [];
  }
  return listActiveCourierWalletBalances(orgId);
}
