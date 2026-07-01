/**
 * Deterministic presentation/size parser. Runs on already-normalized text
 * (see normalize.ts: '2 litros' -> '2l'), so it only needs the canonical unit
 * tokens. Volume is compared in millilitres, weight in grams — same family
 * only. No LLM, no cost: this is what makes "2L" prefer "1.5L" over "3L".
 */

import { normalizeQuery } from './normalize';

export type SizeUnit = 'l' | 'ml' | 'kg' | 'g';
export type SizeFamily = 'volume' | 'weight';

export type ParsedSize = {
  /** The magnitude as written, e.g. 2 for "2l". */
  value: number;
  /** The unit as written. */
  unit: SizeUnit;
  /** Canonical magnitude for comparison: millilitres (volume) or grams (weight). */
  base: number;
  family: SizeFamily;
};

// `ml`/`kg` must precede `l`/`g` so the longer unit wins at the same position.
const SIZE_RE = /(\d+(?:\.\d+)?)(ml|l|kg|g)\b/;

export function parseSize(normalized: string): ParsedSize | null {
  const match = SIZE_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = match[2] as SizeUnit;
  switch (unit) {
    case 'l':
      return { value, unit, base: value * 1000, family: 'volume' };
    case 'ml':
      return { value, unit, base: value, family: 'volume' };
    case 'kg':
      return { value, unit, base: value * 1000, family: 'weight' };
    case 'g':
      return { value, unit, base: value, family: 'weight' };
  }
}

/**
 * Parses the size straight from a raw product name (runs `normalizeQuery`
 * first), so callers with a plain name — not an already-normalized query —
 * don't have to know about that step. Single source of truth for both search
 * ranking (parseSize) and the persisted `products.size` column.
 */
export function sizeFromName(name: string): ParsedSize | null {
  return parseSize(normalizeQuery(name));
}

/**
 * Absolute distance between two sizes in canonical units. Infinity when either
 * is missing or they belong to different families (volume vs weight) — so the
 * ranker treats them as "not comparable" and falls back to score.
 */
export function sizeDistance(a: ParsedSize | null, b: ParsedSize | null): number {
  if (!a || !b || a.family !== b.family) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(a.base - b.base);
}
