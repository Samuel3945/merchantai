// Pure parsing/matching/validation for the inventory entry importer. Kept free
// of React and papaparse so it can be unit-tested directly. Unlike the products
// importer, every row must resolve to a product that ALREADY exists — the file
// only carries an identifier (barcode/name) plus the units to add.

export type EntryDraftRow = {
  id: string;
  // The resolved existing product, or null when the file row could not be
  // matched and the user must pick it from the selector.
  productId: string | null;
  // Raw label from the file (name or barcode), shown when unresolved.
  label: string;
  qty: string;
  unitCost: string;
  expiresAt: string;
};

type MatchTarget = {
  id: string;
  name: string;
  barcode: string | null;
  cost: string;
};

const QTY_RE = /^\d+$/;
// Up to 2 decimals — matches the entry cost the server accepts.
const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '') // strip accents (combining marks after NFD)
    .toLowerCase()
    .trim();
}

type EntryField = 'name' | 'barcode' | 'qty' | 'cost' | 'expires';

const HEADER_ALIASES: Record<string, EntryField> = {
  'nombre': 'name',
  'name': 'name',
  'producto': 'name',
  'descripcion': 'name',
  'codigo de barras': 'barcode',
  'barcode': 'barcode',
  'codigo': 'barcode',
  'cod barras': 'barcode',
  'ean': 'barcode',
  'sku': 'barcode',
  'cantidad': 'qty',
  'cant': 'qty',
  'unidades': 'qty',
  'qty': 'qty',
  'stock': 'qty',
  'costo': 'cost',
  'cost': 'cost',
  'costo unitario': 'cost',
  'compra': 'cost',
  'vence': 'expires',
  'vencimiento': 'expires',
  'caducidad': 'expires',
  'fecha de vencimiento': 'expires',
  'expires': 'expires',
};

export function mapHeaderToField(header: string): EntryField | null {
  return HEADER_ALIASES[normalizeHeader(header)] ?? null;
}

// Case/accent-insensitive name key so "Coca Cola" matches "coca cola".
function nameKey(name: string): string {
  return normalizeHeader(name);
}

type MatchIndex = {
  byBarcode: Map<string, string>;
  byName: Map<string, string>;
};

export function buildMatchIndex(targets: MatchTarget[]): MatchIndex {
  const byBarcode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const t of targets) {
    if (t.barcode) {
      byBarcode.set(t.barcode.trim(), t.id);
    }
    // First write wins on duplicate names — an ambiguous name stays a best-effort
    // guess the user can correct in the selector.
    const key = nameKey(t.name);
    if (!byName.has(key)) {
      byName.set(key, t.id);
    }
  }
  return { byBarcode, byName };
}

// Barcode is the reliable key; name is the fallback. Returns null when neither
// resolves, leaving the row for manual selection.
export function matchProduct(
  barcode: string,
  name: string,
  index: MatchIndex,
): string | null {
  const code = barcode.trim();
  if (code && index.byBarcode.has(code)) {
    return index.byBarcode.get(code)!;
  }
  const key = nameKey(name);
  if (key && index.byName.has(key)) {
    return index.byName.get(key)!;
  }
  return null;
}

// Turns spreadsheet records into draft rows: maps known headers, matches each to
// an existing product, and pre-fills cost from the product when the file omits
// it. Fully-empty rows are dropped.
export function recordsToEntryDrafts(
  records: Record<string, unknown>[],
  targets: MatchTarget[],
): EntryDraftRow[] {
  const index = buildMatchIndex(targets);
  const costById = new Map(targets.map(t => [t.id, t.cost]));

  return records
    .map((rec, i): EntryDraftRow => {
      let name = '';
      let barcode = '';
      let qty = '';
      let cost = '';
      let expires = '';
      for (const [key, value] of Object.entries(rec)) {
        const field = mapHeaderToField(key);
        const v = String(value ?? '').trim();
        if (field === 'name') {
          name = v;
        } else if (field === 'barcode') {
          barcode = v;
        } else if (field === 'qty') {
          qty = v;
        } else if (field === 'cost') {
          cost = v;
        } else if (field === 'expires') {
          expires = v;
        }
      }

      const productId = matchProduct(barcode, name, index);
      // Fall back to the product's saved cost when the file leaves it blank.
      const unitCost
        = cost || (productId ? costById.get(productId) ?? '' : '');

      return {
        id: `entry-row-${i}`,
        productId,
        label: name || barcode,
        qty,
        unitCost,
        expiresAt: expires,
      };
    })
    .filter(d => d.label || d.qty || d.unitCost);
}

// Per-row validation (empty array = importable). isPerishable decides whether an
// expiry is mandatory, mirroring the single-entry server guard.
export function validateEntryDraft(
  d: EntryDraftRow,
  isPerishable: (productId: string) => boolean,
): string[] {
  const errors: string[] = [];
  if (!d.productId) {
    errors.push('Elegí un producto');
  }
  if (!QTY_RE.test(d.qty.trim()) || Number(d.qty) <= 0) {
    errors.push('Cantidad inválida');
  }
  if (!MONEY_RE.test(d.unitCost.trim()) || Number(d.unitCost) <= 0) {
    errors.push('Costo inválido');
  }
  if (d.productId && isPerishable(d.productId) && !d.expiresAt.trim()) {
    errors.push('Falta vencimiento');
  }
  return errors;
}
