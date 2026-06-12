// Expense categories suggested by the UI. The column is free-text, so the
// owner is never blocked from typing a custom category.
//
// Kept in a plain module (NOT in the "use server" actions file): a file with
// the "use server" directive may only export async functions, so a const/array
// export there breaks the Next.js build.
//
// "otros" is special: the UI and createExpense both require a written reason
// (description) for it, otherwise the expense is unauditable.
export const EXPENSE_CATEGORIES = [
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

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
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
