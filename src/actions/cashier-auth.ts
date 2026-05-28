'use server';

import type { CashierSession } from '@/libs/cashier-session';
import {
  loginCashier,
  logoutCashier,
  resolveCashierSession,
} from '@/libs/cashier-session';

export async function cashierLogin(
  email: string,
  password: string,
): Promise<CashierSession> {
  return loginCashier(email, password);
}

export async function cashierLogout(sessionId: string): Promise<void> {
  return logoutCashier(sessionId);
}

export async function validateCashierSession(
  sessionId: string,
): Promise<CashierSession | null> {
  return resolveCashierSession(sessionId);
}
