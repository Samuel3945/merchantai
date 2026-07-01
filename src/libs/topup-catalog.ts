// Server-side source of truth for AI-credit top-up prices. Pure and
// client-safe (no server-only imports) — `AgentKind` is imported as a
// type-only, so this module never pulls '@/actions/plans' ('use server')
// into a client bundle.
import type { AgentKind } from '@/actions/plans';

export type TopUpPackage = {
  id: string;
  requests: number;
  amountCop: number;
};

type PackagePrice = Omit<TopUpPackage, 'id'>;

// AI agents (sales_manager, customer_service).
const AI_AGENT_PACKAGES: PackagePrice[] = [
  { requests: 100, amountCop: 19_000 },
  { requests: 500, amountCop: 79_000 },
  { requests: 1000, amountCop: 139_000 },
];

// E-invoicing credits cost 50 COP each (1 credit = 1 emitted document).
const EINVOICE_CREDIT_PRICE_COP = 50;
const EINVOICE_PACKAGES: PackagePrice[] = [
  { requests: 100, amountCop: 100 * EINVOICE_CREDIT_PRICE_COP },
  { requests: 500, amountCop: 500 * EINVOICE_CREDIT_PRICE_COP },
  { requests: 1000, amountCop: 1000 * EINVOICE_CREDIT_PRICE_COP },
];

function withIds(agentKind: AgentKind, prices: PackagePrice[]): TopUpPackage[] {
  return prices.map(price => ({ id: `${agentKind}_${price.requests}`, ...price }));
}

export const TOPUP_CATALOG: Record<AgentKind, TopUpPackage[]> = {
  sales_manager: withIds('sales_manager', AI_AGENT_PACKAGES),
  customer_service: withIds('customer_service', AI_AGENT_PACKAGES),
  einvoice: withIds('einvoice', EINVOICE_PACKAGES),
};

export function findPackage(
  agentKind: AgentKind,
  packageId: string,
): TopUpPackage | undefined {
  return TOPUP_CATALOG[agentKind]?.find(p => p.id === packageId);
}
