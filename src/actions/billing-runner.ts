'use server';

// runBilling — recurring Wompi charges for due subscriptions.
//
// PORT PENDING: The legacy implementation lives at app/src/actions/subscriptions.ts
// and depends on the wompi_subscriptions / wompi_charges tables plus
// src/lib/wompi.ts. Those tables and helper have not been migrated to
// MerchantAI/app yet, so this stub keeps the cron route wired and the contract
// stable while the engine is being ported. When ready, replace the body with
// the real implementation; the cron endpoint won't need to change.

export type RunBillingResult = {
  processed: number;
  succeeded: number;
  failed: number;
  suspended: number;
  ported: boolean;
};

export async function runBilling(_limit = 100): Promise<RunBillingResult> {
  return {
    processed: 0,
    succeeded: 0,
    failed: 0,
    suspended: 0,
    ported: false,
  };
}
