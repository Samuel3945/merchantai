/**
 * Shared, curated ES-CO grocery synonym groups. Each group is a set of
 * interchangeable terms; the FIRST is the canonical form. Deliberately
 * CONSERVATIVE — a wrong synonym reintroduces the false positives the search
 * fights. Terms are already accent-folded/lowercased to match normalizeQuery
 * output. Extend as real customer queries surface. Plurals are intentionally
 * omitted: the spanish FTS stemmer already handles them.
 */
const SYNONYM_GROUPS: string[][] = [
  ['gaseosa', 'refresco', 'soda'],
  ['panela', 'papelon'],
  ['mani', 'cacahuate', 'cacahuete'],
  ['pitillo', 'popote', 'sorbete'],
  ['fosforos', 'cerillas'],
  ['arveja', 'guisante'],
];

/** Cap on FTS query variants, to keep the OR'd tsquery bounded. */
const MAX_QUERY_VARIANTS = 8;

const CANONICAL = new Map<string, string>();
const GROUP_OF = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0]!;
  for (const term of group) {
    CANONICAL.set(term, canonical);
    GROUP_OF.set(term, group);
  }
}

/** Maps a synonym to its canonical term; unknown tokens map to themselves. */
export function canonicalToken(token: string): string {
  return CANONICAL.get(token) ?? token;
}

/** All interchangeable terms for a token (itself included). */
export function synonymsOf(token: string): string[] {
  return GROUP_OF.get(token) ?? [token];
}

/**
 * The normalized query plus single-token synonym substitutions, for FTS recall:
 * "gaseosa cola" -> ["gaseosa cola", "refresco cola", "soda cola"]. Single-token
 * substitution avoids a cartesian blow-up; the result is capped and deduped.
 */
export function expandQueries(normalized: string): string[] {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const out = new Set<string>([normalized]);

  for (let i = 0; i < tokens.length; i++) {
    const alts = synonymsOf(tokens[i]!);
    if (alts.length <= 1) {
      continue;
    }
    for (const alt of alts) {
      if (alt === tokens[i]) {
        continue;
      }
      const variant = [...tokens];
      variant[i] = alt;
      out.add(variant.join(' '));
    }
  }

  return [...out].slice(0, MAX_QUERY_VARIANTS);
}
