// Pure and client-safe. DEFAULT_TOPUP_PACKAGES is the fallback catalog for
// AI-credit top-up prices — one flat catalog for the single shared credit
// pool (see migration 0082_unify_credit_pool). Priced at the unified rate,
// which raises the per-credit cost for e-invoicing compared to the old 50
// COP/credit bucket — that is intended, since one credit now covers any AI
// or e-invoicing action. The operator can override these at runtime from
// /platform/creditos; see actions/topup-packages.ts#getTopUpPackages.
export type TopUpPackage = {
  id: string;
  requests: number;
  amountCop: number;
};

const PACKAGE_PRICES: Omit<TopUpPackage, 'id'>[] = [
  { requests: 100, amountCop: 19_000 },
  { requests: 500, amountCop: 79_000 },
  { requests: 1000, amountCop: 139_000 },
];

export const DEFAULT_TOPUP_PACKAGES: TopUpPackage[] = PACKAGE_PRICES.map(price => ({
  id: `credits_${price.requests}`,
  ...price,
}));

export function findPackage(
  packages: TopUpPackage[],
  packageId: string,
): TopUpPackage | undefined {
  return packages.find(p => p.id === packageId);
}
