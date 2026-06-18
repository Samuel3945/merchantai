// Treasury-owned canonical expense categories — single source of truth.
// "otros" is special: the UI and recordGasto both require a non-empty description
// for it, otherwise the expense is unauditable.
export const TREASURY_EXPENSE_CATEGORIES = [
  'servicios',
  'arriendo',
  'transporte',
  'mantenimiento',
  'aseo',
  'empaques',
  'papeleria',
  'marketing',
  'impuestos',
  'seguridad',
  'otros',
] as const;

export type TreasuryExpenseCategory = (typeof TREASURY_EXPENSE_CATEGORIES)[number];

export const TREASURY_EXPENSE_CATEGORY_LABELS: Record<TreasuryExpenseCategory, string> = {
  servicios: 'Servicios públicos',
  arriendo: 'Arriendo',
  transporte: 'Transporte y domicilios',
  mantenimiento: 'Mantenimiento y reparaciones',
  aseo: 'Aseo y limpieza',
  empaques: 'Empaques y bolsas',
  papeleria: 'Papelería',
  marketing: 'Publicidad y marketing',
  impuestos: 'Impuestos',
  seguridad: 'Seguridad',
  otros: 'Otros',
};
