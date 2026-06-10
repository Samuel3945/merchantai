// Pure parsing/mapping/validation for the products importer. Kept free of React
// and papaparse so it can be unit-tested directly; the client component feeds it
// the rows papaparse produced.

export type ImportField = 'name' | 'barcode' | 'price' | 'cost' | 'category';

export type DraftRow = {
  id: string;
  name: string;
  barcode: string;
  price: string;
  cost: string;
  category: string;
};

// Up to 2 decimals — same shape the product validation schema accepts.
const PRICE_RE = /^\d+(?:\.\d{1,2})?$/;

export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/gu, '') // strip accents
    .toLowerCase()
    .trim();
}

// Maps common Spanish/English column headers to our fields, so a shop's own
// spreadsheet usually imports with no manual mapping.
const HEADER_ALIASES: Record<string, ImportField> = {
  'nombre': 'name',
  'name': 'name',
  'producto': 'name',
  'descripcion': 'name',
  'precio': 'price',
  'price': 'price',
  'precio de venta': 'price',
  'venta': 'price',
  'pvp': 'price',
  'costo': 'cost',
  'cost': 'cost',
  'precio de costo': 'cost',
  'compra': 'cost',
  'categoria': 'category',
  'category': 'category',
  'rubro': 'category',
  'codigo de barras': 'barcode',
  'barcode': 'barcode',
  'codigo': 'barcode',
  'cod barras': 'barcode',
  'ean': 'barcode',
  'sku': 'barcode',
};

export function mapHeaderToField(header: string): ImportField | null {
  return HEADER_ALIASES[normalizeHeader(header)] ?? null;
}

// Turns papaparse records (objects keyed by raw header) into draft rows, mapping
// recognized headers to fields and dropping fully-empty rows.
export function recordsToDrafts(records: Record<string, unknown>[]): DraftRow[] {
  return records
    .map((rec, i) => {
      const draft: DraftRow = {
        id: `row-${i}`,
        name: '',
        barcode: '',
        price: '',
        cost: '',
        category: '',
      };
      for (const [key, value] of Object.entries(rec)) {
        const field = mapHeaderToField(key);
        if (field) {
          draft[field] = String(value ?? '').trim();
        }
      }
      return draft;
    })
    .filter(
      d => d.name || d.price || d.barcode || d.cost || d.category,
    );
}

// Per-row validation messages (empty array = row is importable).
export function validateDraft(d: DraftRow): string[] {
  const errors: string[] = [];
  if (!d.name.trim()) {
    errors.push('Falta el nombre');
  }
  if (!PRICE_RE.test(d.price.trim())) {
    errors.push('Precio inválido');
  }
  if (d.cost.trim() !== '' && !PRICE_RE.test(d.cost.trim())) {
    errors.push('Costo inválido');
  }
  return errors;
}
