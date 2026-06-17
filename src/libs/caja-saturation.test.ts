import type { SaleRecord, SaturationConfig } from '@/libs/caja-saturation';
import { describe, expect, it } from 'vitest';
import {
  computeCajaSaturation,
  computeSaturationReport,
  groupByBusinessDay,
  isBusinessDaySaturated,
} from '@/libs/caja-saturation';

// Pure, dependency-free saturation model. "A caja is saturated when, recurrently,
// the cashier barely rests for HOURS at a time." Operationalized as: the busiest
// 2h window of a day has high utilization (estimated handling time / window),
// and that happens on a meaningful share of the days the caja operated.
//
// Tests pin the design decisions we agreed on:
//   - PEAK window, not daily average (a quiet evening can't dilute a lunch rush)
//   - effort counts by cart LINES, not units (a 2.2kg line is one line)
//   - a sales-count floor keeps "stream of customers", not 3 giant orders
//   - business days are cut in the org timezone (international-ready)

// Round numbers so utilization is mental math: each cart line = 2 min of handling.
function cfg(over: Partial<SaturationConfig> = {}): SaturationConfig {
  return {
    timezone: 'America/Bogota',
    windowDays: 30,
    baseSecondsPerSale: 0,
    secondsPerLine: 120, // 2 min per line
    peakWindowMinutes: 120, // 2h
    utilizationThreshold: 0.75,
    minSalesInPeak: 10,
    recurrenceRatio: 0.4,
    minSaturatedDays: 5,
    ...over,
  };
}

// `count` sales starting at `startISO`, spaced `stepMin` apart, each `lineCount` lines.
function stream(
  startISO: string,
  count: number,
  stepMin: number,
  lineCount = 1,
): SaleRecord[] {
  const start = new Date(startISO).getTime();
  return Array.from({ length: count }, (_, k) => ({
    occurredAt: new Date(start + k * stepMin * 60_000),
    lineCount,
  }));
}

function at(iso: string, lineCount = 1): SaleRecord {
  return { occurredAt: new Date(iso), lineCount };
}

describe('isBusinessDaySaturated (peak 2h window)', () => {
  it('a 2h nonstop run saturates the day', () => {
    // 60 sales every 2 min from 12:00 → window [12:00,14:00) is 100% busy.
    const sales = stream('2026-06-10T12:00:00-05:00', 60, 2, 1);

    expect(isBusinessDaySaturated(sales, cfg())).toBe(true);
  });

  it('the same workload spread thin is NOT saturated', () => {
    // 30 sales every 4 min → best 2h window is only 50% busy.
    const sales = stream('2026-06-10T12:00:00-05:00', 30, 4, 1);

    expect(isBusinessDaySaturated(sales, cfg())).toBe(false);
  });

  it('a lunch rush is NOT diluted by quiet evening sales (peak, not average)', () => {
    // This is the whole point: daily average over 12:00→19:00 would be ~28%,
    // but the 12:00–14:00 block was a real saturation peak.
    const sales = [
      ...stream('2026-06-10T12:00:00-05:00', 60, 2, 1),
      at('2026-06-10T18:00:00-05:00'),
      at('2026-06-10T19:00:00-05:00'),
    ];

    expect(isBusinessDaySaturated(sales, cfg())).toBe(true);
  });

  it('slow but line-heavy sales saturate (effort counts, not just frequency)', () => {
    // 12 sales every 10 min, 4 lines each = 8 min handling each → 96 of 120 min.
    const sales = stream('2026-06-10T12:00:00-05:00', 12, 10, 4);

    expect(isBusinessDaySaturated(sales, cfg())).toBe(true);
  });

  it('a handful of giant orders does NOT saturate (sales-count floor)', () => {
    // 3 enormous sales fill the window by handling, but it is not a customer
    // stream — the floor (minSalesInPeak) rejects it.
    const sales = stream('2026-06-10T12:00:00-05:00', 3, 40, 100);

    expect(isBusinessDaySaturated(sales, cfg())).toBe(false);
  });

  it('a short but intense burst is NOT "hours" of saturation', () => {
    // 30 sales every 1 min = 30 min of slam, then nothing. Window denominator is
    // a fixed 2h, so 30 min of work can never reach 75%.
    const sales = stream('2026-06-10T12:00:00-05:00', 30, 1, 1);

    expect(isBusinessDaySaturated(sales, cfg())).toBe(false);
  });

  it('an empty day is not saturated', () => {
    expect(isBusinessDaySaturated([], cfg())).toBe(false);
  });
});

describe('groupByBusinessDay (timezone-aware)', () => {
  it('cuts the day in the org timezone, not UTC', () => {
    // 23:30 and 00:30 UTC straddle the UTC midnight but are both ~evening in Bogotá.
    const sales = [
      at('2026-06-10T23:30:00Z'),
      at('2026-06-11T00:30:00Z'),
    ];

    expect(groupByBusinessDay(sales, 'America/Bogota').size).toBe(1);
    expect(groupByBusinessDay(sales, 'UTC').size).toBe(2);
  });
});

describe('computeCajaSaturation (recurrence)', () => {
  // A saturated day = the 60-every-2-min lunch run on that date.
  function saturatedDay(dateISO: string): SaleRecord[] {
    return stream(`${dateISO}T12:00:00-05:00`, 60, 2, 1);
  }

  // An operating-but-calm day = a couple of sales.
  function calmDay(dateISO: string): SaleRecord[] {
    return [at(`${dateISO}T09:00:00-05:00`), at(`${dateISO}T15:00:00-05:00`)];
  }

  function caja(sales: SaleRecord[]) {
    return { posTokenId: 'tok-1', deviceName: 'Caja 1', sales };
  }

  it('saturated when ≥5 saturated days AND ≥40% of operating days', () => {
    const days = [
      ...['01', '02', '03', '04', '05'].map(d => saturatedDay(`2026-06-${d}`)),
      ...['06', '07', '08', '09', '10'].map(d => calmDay(`2026-06-${d}`)),
    ];
    const result = computeCajaSaturation(caja(days.flat()), cfg());

    expect(result.operatingDays).toBe(10);
    expect(result.saturatedDays).toBe(5);
    expect(result.saturated).toBe(true);
  });

  it('NOT saturated below the 5-day floor, even at 100%', () => {
    const days = ['01', '02', '03', '04'].map(d => saturatedDay(`2026-06-${d}`));
    const result = computeCajaSaturation(caja(days.flat()), cfg());

    expect(result.saturatedDays).toBe(4);
    expect(result.saturated).toBe(false);
  });

  it('NOT saturated when saturated days are a rare minority (<40%)', () => {
    const days = [
      ...['01', '02', '03', '04', '05'].map(d => saturatedDay(`2026-06-${d}`)),
      ...Array.from({ length: 15 }, (_, k) =>
        calmDay(`2026-06-${String(k + 6).padStart(2, '0')}`)),
    ];
    const result = computeCajaSaturation(caja(days.flat()), cfg());

    expect(result.operatingDays).toBe(20);
    expect(result.saturatedDays).toBe(5);
    expect(result.saturated).toBe(false);
  });

  it('an idle caja is not saturated', () => {
    const result = computeCajaSaturation(caja([]), cfg());

    expect(result.operatingDays).toBe(0);
    expect(result.saturated).toBe(false);
  });

  it('passes the sede (branch label) through to the result', () => {
    const withSede = { posTokenId: 'tok-1', deviceName: 'Caja 1', sede: 'Centro', sales: [] };

    expect(computeCajaSaturation(withSede, cfg()).sede).toBe('Centro');
    // Defaults to null when the caja has no branch label.
    expect(computeCajaSaturation(caja([]), cfg()).sede).toBeNull();
  });
});

describe('computeSaturationReport', () => {
  it('flags the report when any caja is saturated and names it', () => {
    const busy = stream('2026-06-10T12:00:00-05:00', 60, 2, 1);
    const dates = ['01', '02', '03', '04', '05', '06'];
    const report = computeSaturationReport(
      [
        {
          posTokenId: 'busy',
          deviceName: 'Mostrador',
          sales: dates
            .map(d => stream(`2026-06-${d}T12:00:00-05:00`, 60, 2, 1))
            .flat(),
        },
        { posTokenId: 'idle', deviceName: 'Depósito', sales: busy.slice(0, 1) },
      ],
      cfg(),
    );

    expect(report.saturated).toBe(true);
    expect(report.cajas.find(c => c.posTokenId === 'busy')?.saturated).toBe(true);
    expect(report.cajas.find(c => c.posTokenId === 'idle')?.saturated).toBe(false);
  });
});
