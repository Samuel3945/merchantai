/**
 * Pure ranking/decision engine for product search. No DB access — takes the
 * raw candidate rows already fetched via trigram similarity + FTS (see
 * src/app/api/agent/products/route.ts) and decides tiers, ordering, and the
 * overall response shape/status.
 *
 * Tier priority (best to worst): exact > strong > partial > fuzzy. Short
 * queries (<=4 normalized chars) can NEVER fall back to fuzzy — that is what
 * keeps "pan" from ever matching "panela".
 */
import type { ParsedSize } from './size';
import { normalizeQuery, tokenize } from './normalize';
import { parseSize, sizeDistance } from './size';
import { canonicalToken } from './synonyms';

export type Candidate = {
  id: string;
  name: string;
  price: string;
  stock: number;
  category: string | null;
  unitType: string;
  barcode: string | null;
  sim: number;
  ftsRank: number;
};

export type Tier = 'exact' | 'strong' | 'partial' | 'fuzzy';

export type SearchStatus
  = | 'exact_match'
    | 'multiple_matches'
    | 'no_match_with_alternatives'
    | 'not_found';

export type ResultItem = {
  id: string;
  name: string;
  price: string;
  stock: number;
  in_stock: boolean;
  unit_type: string;
  category: string | null;
  size: { value: number; unit: string } | null;
  match: Tier;
  score: number;
};

export type AltItem = ResultItem & { reason: string };

export type SearchResponse = {
  status: SearchStatus;
  query: string;
  normalized: string;
  results: ResultItem[];
  alternatives: AltItem[];
  clarification: {
    needed: boolean;
    reason: string | null;
    options: string[];
  };
  meta: {
    candidates: number;
    returned: number;
    limit: number;
  };
};

type Classified = {
  candidate: Candidate;
  tier: Tier;
  score: number;
  size: ParsedSize | null;
};

const UNIT_TOKEN_RE = /^\d+(?:\.\d+)?(?:l|ml|kg|g)$/;

/**
 * Fuzzy-match trigram-similarity floor. Short queries never qualify for
 * fuzzy (2 is above the [0,1] similarity range, so it's unreachable) — they
 * must land as exact/strong or be rejected entirely.
 */
function fuzzyThreshold(qlen: number): number {
  if (qlen <= 4) {
    return 2;
  }
  if (qlen <= 7) {
    return 0.45;
  }
  if (qlen <= 11) {
    return 0.35;
  }
  return 0.3;
}

function classify(
  rawQuery: string,
  normalized: string,
  qTokens: string[],
  qlen: number,
  candidate: Candidate,
): Classified | null {
  const normName = normalizeQuery(candidate.name);
  const nameTokens = tokenize(normName);
  const size = parseSize(normName);
  const at = (tier: Tier, score: number): Classified => ({ candidate, tier, score, size });

  if (candidate.barcode && candidate.barcode === rawQuery.trim()) {
    return at('exact', 1);
  }

  if (normName === normalized) {
    return at('exact', 1);
  }

  if (qTokens.length > 0) {
    const nameCanon = new Set(nameTokens.map(canonicalToken));
    if (qTokens.every(t => nameCanon.has(canonicalToken(t)))) {
      return at('strong', 0.9 + Math.min(candidate.sim, 0.09));
    }
  }

  if (candidate.ftsRank > 0 && qlen >= 4) {
    return at('partial', 0.5 + Math.min(candidate.ftsRank, 0.3) + candidate.sim * 0.1);
  }

  if (candidate.sim >= fuzzyThreshold(qlen)) {
    return at('fuzzy', 0.3 + candidate.sim * 0.2);
  }

  return null;
}

const TIER_ORDER: Record<Tier, number> = {
  exact: 0,
  strong: 1,
  partial: 2,
  fuzzy: 3,
};

function sortClassified(items: Classified[], qSize: ParsedSize | null): Classified[] {
  return [...items].sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) {
      return tierDiff;
    }

    const aInStock = a.candidate.stock > 0 ? 1 : 0;
    const bInStock = b.candidate.stock > 0 ? 1 : 0;
    if (aInStock !== bInStock) {
      return bInStock - aInStock;
    }

    // When the query asked for a size, prefer the nearest available one
    // (2L → 1.5L before 3L). No query size → both distances are Infinity and
    // this is a no-op, falling through to the score.
    const aDist = sizeDistance(qSize, a.size);
    const bDist = sizeDistance(qSize, b.size);
    if (aDist !== bDist) {
      return aDist - bDist;
    }

    return b.score - a.score;
  });
}

function toResultItem(item: Classified): ResultItem {
  return {
    id: item.candidate.id,
    name: item.candidate.name,
    price: item.candidate.price,
    stock: item.candidate.stock,
    in_stock: item.candidate.stock > 0,
    unit_type: item.candidate.unitType,
    category: item.candidate.category,
    size: item.size ? { value: item.size.value, unit: item.size.unit } : null,
    match: item.tier,
    score: Math.round(item.score * 100) / 100,
  };
}

/**
 * Classifies why a weak (partial/fuzzy) result is being offered as an
 * alternative rather than a direct hit: same product in a different
 * presentation/size, the same product line, or just a similar-looking name.
 */
function classifyAltReason(normalized: string, candidateName: string): string {
  const qTokens = tokenize(normalized);
  const nTokens = tokenize(normalizeQuery(candidateName));

  const qNonUnit = qTokens.filter(t => !UNIT_TOKEN_RE.test(t));
  const nNonUnit = nTokens.filter(t => !UNIT_TOKEN_RE.test(t));

  const sameBase = qNonUnit.length > 0 && qNonUnit.every(t => nNonUnit.includes(t));
  const bothHaveUnitToken
    = qTokens.some(t => UNIT_TOKEN_RE.test(t)) && nTokens.some(t => UNIT_TOKEN_RE.test(t));

  if (sameBase && bothHaveUnitToken) {
    return 'other_presentation';
  }

  if (sameBase) {
    return 'same_line';
  }

  return 'similar_product';
}

function toAltItem(item: Classified, normalized: string): AltItem {
  return {
    ...toResultItem(item),
    reason: classifyAltReason(normalized, item.candidate.name),
  };
}

/**
 * Classifies every candidate, sorts by tier/in-stock/score, and decides the
 * overall search status + clarification prompt.
 */
export function rankAndDecide(
  rawQuery: string,
  candidates: Candidate[],
  limit: number,
): SearchResponse {
  const normalized = normalizeQuery(rawQuery);
  const qTokens = tokenize(normalized);
  const qlen = normalized.replace(/\s/g, '').length;
  const qSize = parseSize(normalized);

  const classified = candidates
    .map(candidate => classify(rawQuery, normalized, qTokens, qlen, candidate))
    .filter((c): c is Classified => c !== null);

  const sorted = sortClassified(classified, qSize);

  const strong = sorted.filter(c => c.tier === 'exact' || c.tier === 'strong');
  const weak = sorted.filter(c => c.tier === 'partial' || c.tier === 'fuzzy');

  let status: SearchStatus;
  let results: ResultItem[];
  let alternatives: AltItem[];

  if (strong.length > 0) {
    const limited = strong.slice(0, limit);
    results = limited.map(toResultItem);
    alternatives = weak.slice(0, limit).map(item => toAltItem(item, normalized));
    status = strong.length === 1 ? 'exact_match' : 'multiple_matches';
  } else if (weak.length > 0) {
    results = [];
    alternatives = weak.slice(0, limit).map(item => toAltItem(item, normalized));
    status = 'no_match_with_alternatives';
  } else {
    results = [];
    alternatives = [];
    status = 'not_found';
  }

  const clarification
    = status === 'multiple_matches' && results.length > 1
      ? {
          needed: true,
          reason: 'multiple_matches',
          options: results.slice(0, 5).map(r => r.name),
        }
      : { needed: false, reason: null, options: [] };

  return {
    status,
    query: rawQuery,
    normalized,
    results,
    alternatives,
    clarification,
    meta: {
      candidates: candidates.length,
      returned: results.length,
      limit,
    },
  };
}
