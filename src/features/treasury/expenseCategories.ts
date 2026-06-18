// Treasury-owned canonical expense categories.
// This module is the single source of truth for the structured category taxonomy.
// "otros" is special: the UI and recordGasto both require a non-empty description
// for it, otherwise the expense is unauditable.
//
// Slice 3 will delete src/features/expenses/ and ExpensesClient.tsx; that module
// also uses categories — it imports from features/expenses/categories.ts which is
// a separate (older) list. After Slice 3, this module is the only definition.
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
