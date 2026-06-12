// Wholesale tier pricing. Tiers are stored on products.wholesale_tiers (jsonb)
// as [{ minQty, price }] by the product form; this module is the single place
// that parses that shape and resolves the unit price for a quantity.

export type WholesaleTier = { minQty: number; price: number };

export function parseWholesaleTiers(raw: unknown): WholesaleTier[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tiers: WholesaleTier[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    // Accept both the stored camelCase shape and the snake_case wire shape.
    const minQty = Number(rec.minQty ?? rec.min_qty);
    const price = Number(rec.price);
    if (Number.isFinite(minQty) && minQty >= 2 && Number.isFinite(price) && price > 0) {
      tiers.push({ minQty, price });
    }
  }
  return tiers.sort((a, b) => a.minQty - b.minQty);
}

// Best tier the quantity qualifies for (highest minQty <= qty); base otherwise.
export function wholesaleUnitPrice(
  basePrice: number,
  isWholesale: boolean,
  rawTiers: unknown,
  qty: number,
): number {
  if (!isWholesale) {
    return basePrice;
  }
  let best = basePrice;
  for (const tier of parseWholesaleTiers(rawTiers)) {
    if (qty >= tier.minQty) {
      best = tier.price;
    }
  }
  return best;
}
