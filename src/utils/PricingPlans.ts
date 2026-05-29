import type { PricingPlan } from '@/types/Subscription';

/** Pricing plans */
export const PLAN_NAME = {
  FREE: 'free',
  PREMIUM: 'premium',
  ENTERPRISE: 'enterprise',
} as const;

// Plan limits map to product features:
//   teamMember -> cajeros, website -> sucursales,
//   storage -> productos en catálogo, transfer -> créditos de IA / mes
/** Configuration for the Free subscription plan. */
const FreePlan: PricingPlan = {
  name: PLAN_NAME.FREE,
  price: 0,
  limits: {
    teamMember: 1,
    website: 1,
    storage: 50,
    transfer: 30,
  },
};

/** List of paid subscription plans. */
const PaidPlans: PricingPlan[] = [
  {
    name: PLAN_NAME.PREMIUM,
    price: 79, // Due to bugs in Alchemy.run, use a new `lookupKey` when changing price
    limits: {
      teamMember: 5,
      website: 3,
      storage: 1000,
      transfer: 500,
    },
  },
  {
    name: PLAN_NAME.ENTERPRISE,
    price: 199, // Due to bugs in Alchemy.run, use a new `lookupKey` when changing price
    limits: {
      teamMember: 50,
      website: 20,
      storage: 50000,
      transfer: 5000,
    },
  },
];

export const AllPlans = [FreePlan, ...PaidPlans];
