// Cash-security risk policy — the business rules for "when should the owner be
// nudged to move cash to a safe place". Kept as explicit, readable constants
// (not an opaque formula) so the policy is explainable and can be re-calibrated
// in one place without touching the engine logic.
//
// Pure module: no DB, no server-only imports — safe to import from client code
// for labels and band styling.

export type CashRiskLevel = 'normal' | 'preventivo' | 'alto' | 'critico';

export const CASH_SECURITY_POLICY = {
  /** Below this many operated days we don't recommend — not enough history. */
  minOperatingDays: 5,
  /** Rolling window the engine looks back over. */
  lookbackDays: 30,

  /**
   * Daily-intake multiplier as an explicit step table (Signal A). Reads in plain
   * language: "a small shop should move cash once the drawer holds ~1.7× what it
   * takes in on an average day". The multiplier shrinks as the business grows
   * because larger operations naturally hold more working cash.
   */
  inflowBands: [
    { upTo: 500_000, multiplier: 1.7 },
    { upTo: 2_000_000, multiplier: 1.5 },
    { upTo: 10_000_000, multiplier: 1.4 },
    { upTo: Number.POSITIVE_INFINITY, multiplier: 1.3 },
  ],

  /**
   * Signal B — the business's own habitual standing cash. We take a high
   * percentile of the end-of-day cash it usually keeps, plus a small margin, so
   * an accumulator is judged against ITS normal level, not a generic number.
   */
  accumulatedPercentile: 0.85,
  accumulatedSafetyFactor: 1.1,

  /**
   * Risk bands, expressed as ratio = currentCash / threshold. The alert starts
   * at `preventivo` (below the threshold) so it prevents rather than reacts.
   */
  bands: {
    preventivo: 0.75,
    alto: 1.0,
    critico: 1.5,
  },
} as const;

/** Signal-A multiplier for a given average daily cash intake. */
export function inflowMultiplier(avgDailyInflow: number): number {
  for (const band of CASH_SECURITY_POLICY.inflowBands) {
    if (avgDailyInflow <= band.upTo) {
      return band.multiplier;
    }
  }
  return CASH_SECURITY_POLICY.inflowBands.at(-1)!.multiplier;
}

/** Maps the cash/threshold ratio to a risk level using the policy bands. */
export function riskLevelForRatio(ratio: number): CashRiskLevel {
  const { bands } = CASH_SECURITY_POLICY;
  if (ratio >= bands.critico) {
    return 'critico';
  }
  if (ratio >= bands.alto) {
    return 'alto';
  }
  if (ratio >= bands.preventivo) {
    return 'preventivo';
  }
  return 'normal';
}

const LEVEL_LABEL: Record<CashRiskLevel, string> = {
  normal: 'Normal',
  preventivo: 'Preventivo',
  alto: 'Alto',
  critico: 'Crítico',
};

export function riskLevelLabel(level: CashRiskLevel): string {
  return LEVEL_LABEL[level];
}
