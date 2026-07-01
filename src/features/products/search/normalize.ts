/**
 * Pure text-normalization helpers for product search. No DB access — these are
 * shared between the ranking engine (src/features/products/search/ranking.ts)
 * and the /api/agent/products route, which also mirrors the SQL side
 * (immutable_unaccent, migrations/0077_product_search_trgm_fts.sql) so a query
 * normalized here matches what similarity()/to_tsvector() see in Postgres.
 */

// Combining diacritical marks (U+0300-U+036F) left behind by NFD decomposition.
const DIACRITICS_RE = /[\u0300-\u036F]/g;
const NON_ALLOWED_RE = /[^a-z0-9\s.]/g;
const MULTI_SPACE_RE = /\s+/g;

/**
 * Lowercases, strips accents, and keeps only [a-z0-9\s.] (everything else
 * becomes a space), then collapses whitespace.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .replace(NON_ALLOWED_RE, ' ')
    .replace(MULTI_SPACE_RE, ' ')
    .trim();
}

// Unit normalization — collapses common Spanish unit spellings/spacing into a
// canonical `<number><unit>` token (e.g. "2 litros" -> "2l"). Order matters:
// longer/more specific unit names are matched before shorter ones so e.g.
// "kilogramos" isn't partially eaten by a "kg"-only pattern.
const UNIT_RULES: [RegExp, string][] = [
  [/\b(\d+(?:\.\d+)?)\s*(?:litros?|lts?|l)\b/g, '$1l'],
  [/\b(\d+(?:\.\d+)?)\s*(?:mililitros?|ml)\b/g, '$1ml'],
  // "kg" alone is a strict subset of "kgs?" (already matches "kg"/"kgs"), so it
  // is omitted — keeping it is dead code the alternation would never reach.
  [/\b(\d+(?:\.\d+)?)\s*(?:kilos?|kilogramos?|kgs?|k)\b/g, '$1kg'],
  // Same reasoning: "gr" is a strict subset of "grs?".
  [/\b(\d+(?:\.\d+)?)\s*(?:gramos?|grs?|g)\b/g, '$1g'],
];

/**
 * `normalizeText` plus unit-spelling normalization, so "2 Litros" and "2l"
 * compare equal.
 */
export function normalizeQuery(input: string): string {
  let normalized = normalizeText(input);

  for (const [pattern, replacement] of UNIT_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.replace(MULTI_SPACE_RE, ' ').trim();
}

/**
 * Splits an already-normalized string into tokens, trimming stray leading/
 * trailing dots per token (decimal-adjacent punctuation) and dropping empties.
 */
export function tokenize(normalized: string): string[] {
  return normalized
    .split(/\s+/)
    .map(token => token.replace(/^\.+|\.+$/g, ''))
    .filter(token => token.length > 0);
}
