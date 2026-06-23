// Pure parsing/mapping/validation for the suppliers importer. Kept free of React
// and papaparse so it can be unit-tested directly; the client component feeds it
// the rows papaparse produced.

export type ImportField = 'name' | 'phone' | 'email' | 'city' | 'taxId';

export type DraftRow = {
  id: string;
  name: string;
  phone: string;
  email: string;
  city: string;
  taxId: string;
};

// The segment before the dot excludes '.' so the two character classes can't
// overlap — keeps the matcher linear (no catastrophic backtracking).
const EMAIL_RE = /^[^\s@]+@[^\s.@]+\.[^\s@]+$/;

export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/gu, '') // strip accents
    .toLowerCase()
    .trim();
}

// Maps common Spanish/English column headers to our fields, so a shop's own
// spreadsheet (or a list read from a photo) usually imports with no manual mapping.
const HEADER_ALIASES: Record<string, ImportField> = {
  'nombre': 'name',
  'name': 'name',
  'proveedor': 'name',
  'razon social': 'name',
  'contacto': 'name',
  'telefono': 'phone',
  'phone': 'phone',
  'tel': 'phone',
  'celular': 'phone',
  'movil': 'phone',
  'whatsapp': 'phone',
  'correo': 'email',
  'email': 'email',
  'correo electronico': 'email',
  'mail': 'email',
  'e-mail': 'email',
  'ciudad': 'city',
  'city': 'city',
  'municipio': 'city',
  'nit': 'taxId',
  'tax id': 'taxId',
  'taxid': 'taxId',
  'rut': 'taxId',
  'identificacion': 'taxId',
  'documento': 'taxId',
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
        phone: '',
        email: '',
        city: '',
        taxId: '',
      };
      for (const [key, value] of Object.entries(rec)) {
        const field = mapHeaderToField(key);
        if (field) {
          draft[field] = String(value ?? '').trim();
        }
      }
      return draft;
    })
    .filter(d => d.name || d.phone || d.email || d.city || d.taxId);
}

// Per-row validation messages (empty array = row is importable). Mirrors the
// server rule: a supplier needs a name and at least one way to reach it.
export function validateDraft(d: DraftRow): string[] {
  const errors: string[] = [];
  if (!d.name.trim()) {
    errors.push('Falta el nombre');
  }
  const phone = d.phone.trim();
  const email = d.email.trim();
  if (!phone && !email) {
    errors.push('Falta teléfono o correo');
  }
  if (email !== '' && !EMAIL_RE.test(email)) {
    errors.push('Correo inválido');
  }
  return errors;
}
