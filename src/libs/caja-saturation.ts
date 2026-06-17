// Pure, dependency-free caja saturation model. No db, no clerk — so it can be
// unit-tested exhaustively and reused by the server core (actions/sales.ts).
//
// THE QUESTION IT ANSWERS
// "Is this register working at its limit so often that the merchant should put a
// second caja on the floor?" The honest signal is REST: a saturated cashier
// barely gets breathing room for HOURS at a time, and it happens regularly.
//
// HOW IT IS MEASURED (and why)
//   1. Effort per sale ≈ baseSecondsPerSale + lineCount × secondsPerLine.
//      We count cart LINES, not units, so a 2.2 kg line weighs the same as a
//      single-unit line and weight products don't distort the estimate.
//   2. A day's saturation is the utilization of its BUSIEST 2h window
//      (Σ handling / window), NOT the daily average — a quiet evening must not
//      dilute a real lunch rush. The fixed 2h denominator is what encodes
//      "for HOURS it didn't stop": a 30-minute burst can never reach the bar.
//   3. A sales-count floor in that window keeps the meaning "a stream of
//      customers", so three giant orders don't masquerade as saturation.
//   4. A caja is saturated only when saturated days are RECURRENT: at least
//      `minSaturatedDays` of them AND at least `recurrenceRatio` of the days the
//      caja actually operated.
//
// All times are real BUSINESS times (`occurredAt`). Days are cut in the org
// timezone so the model is correct internationally, not just in Colombia.

export type SaturationConfig = {
  /** IANA timezone used to cut business days, e.g. 'America/Bogota'. */
  timezone: string;
  /** Trailing window the caller queries over. The model does not re-filter. */
  windowDays: number;
  /** Fixed handling overhead per transaction (greet, tender, receipt). */
  baseSecondsPerSale: number;
  /** Estimated handling time added by each cart line. */
  secondsPerLine: number;
  /** Size of the sliding peak window, in minutes (the "for hours" horizon). */
  peakWindowMinutes: number;
  /** Utilization (busy time / window) at or above which the window is saturated. */
  utilizationThreshold: number;
  /** Minimum sales inside the peak window for it to count as a customer stream. */
  minSalesInPeak: number;
  /** Saturated-days / operating-days ratio at or above which the caja is saturated. */
  recurrenceRatio: number;
  /** Absolute floor of saturated days, so thin history can't trigger the alert. */
  minSaturatedDays: number;
};

// Guesses, tunable per business. Kept here so there is a single source of truth
// the future Ajustes screen can override. They are deliberately conservative so
// the alert under-fires rather than crying wolf.
export const DEFAULT_SATURATION_CONFIG: SaturationConfig = {
  timezone: 'America/Bogota',
  windowDays: 30,
  baseSecondsPerSale: 20,
  secondsPerLine: 15,
  peakWindowMinutes: 120,
  utilizationThreshold: 0.75,
  minSalesInPeak: 10,
  recurrenceRatio: 0.4,
  minSaturatedDays: 5,
};

export type SaleRecord = {
  /** Real business time of the sale (NOT the server insert time). */
  occurredAt: Date;
  /** Number of cart lines (sale_items rows) on the sale. */
  lineCount: number;
};

export type CajaSales = {
  posTokenId: string;
  deviceName: string | null;
  // Branch/location label (org_addresses.name) — lets the alert pinpoint WHICH
  // sede is saturated in a multi-branch business. A pure passthrough; it never
  // affects the saturation math.
  sede?: string | null;
  sales: SaleRecord[];
};

export type CajaSaturationResult = {
  posTokenId: string;
  deviceName: string | null;
  sede: string | null;
  totalSales: number;
  operatingDays: number;
  saturatedDays: number;
  saturated: boolean;
};

export type SaturationReport = {
  /** True when at least one caja is at its working limit. */
  saturated: boolean;
  cajas: CajaSaturationResult[];
};

// Estimated seconds of cashier work a single sale represents.
export function handlingSeconds(sale: SaleRecord, config: SaturationConfig): number {
  return config.baseSecondsPerSale + sale.lineCount * config.secondsPerLine;
}

// 'YYYY-MM-DD' label of the business day a moment falls on, in the given tz.
// en-CA renders ISO-style dates, which sort lexicographically by calendar day.
function businessDayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Buckets sales into business days using the org timezone.
export function groupByBusinessDay(
  sales: SaleRecord[],
  timezone: string,
): Map<string, SaleRecord[]> {
  const byDay = new Map<string, SaleRecord[]>();
  for (const sale of sales) {
    const key = businessDayKey(sale.occurredAt, timezone);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(sale);
    } else {
      byDay.set(key, [sale]);
    }
  }
  return byDay;
}

// A day is saturated when SOME peak-sized window is busy past the threshold and
// carries enough sales to be a real stream. Two pointers sweep the day once: the
// window always starts at a sale, so as the left edge advances the right edge
// only moves forward.
export function isBusinessDaySaturated(
  daySales: SaleRecord[],
  config: SaturationConfig,
): boolean {
  if (daySales.length < config.minSalesInPeak) {
    return false;
  }

  const sorted = [...daySales].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const windowMs = config.peakWindowMinutes * 60_000;
  const windowSeconds = config.peakWindowMinutes * 60;
  const minBusySeconds = windowSeconds * config.utilizationThreshold;

  let right = 0;
  let busySeconds = 0;
  let countInWindow = 0;

  for (let left = 0; left < sorted.length; left++) {
    const windowEnd = sorted[left]!.occurredAt.getTime() + windowMs;
    while (
      right < sorted.length
      && sorted[right]!.occurredAt.getTime() < windowEnd
    ) {
      busySeconds += handlingSeconds(sorted[right]!, config);
      countInWindow += 1;
      right += 1;
    }

    if (countInWindow >= config.minSalesInPeak && busySeconds >= minBusySeconds) {
      return true;
    }

    // Drop the left sale before the window slides to the next start.
    busySeconds -= handlingSeconds(sorted[left]!, config);
    countInWindow -= 1;
  }

  return false;
}

// Per-caja verdict: count operating days vs saturated days, then apply the
// recurrence ratio and the absolute floor.
export function computeCajaSaturation(
  caja: CajaSales,
  config: SaturationConfig,
): CajaSaturationResult {
  const byDay = groupByBusinessDay(caja.sales, config.timezone);
  const operatingDays = byDay.size;

  let saturatedDays = 0;
  for (const daySales of byDay.values()) {
    if (isBusinessDaySaturated(daySales, config)) {
      saturatedDays += 1;
    }
  }

  const saturated
    = saturatedDays >= config.minSaturatedDays
      && operatingDays > 0
      && saturatedDays / operatingDays >= config.recurrenceRatio;

  return {
    posTokenId: caja.posTokenId,
    deviceName: caja.deviceName,
    sede: caja.sede ?? null,
    totalSales: caja.sales.length,
    operatingDays,
    saturatedDays,
    saturated,
  };
}

// Org-wide report: one verdict per caja, plus a roll-up flag.
export function computeSaturationReport(
  cajas: CajaSales[],
  config: SaturationConfig,
): SaturationReport {
  const results = cajas.map(caja => computeCajaSaturation(caja, config));
  return {
    saturated: results.some(c => c.saturated),
    cajas: results,
  };
}
