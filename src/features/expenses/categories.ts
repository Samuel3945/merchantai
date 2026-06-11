// Expense categories suggested by the UI. The column is free-text, so the
// owner is never blocked from typing a custom category.
//
// Kept in a plain module (NOT in the "use server" actions file): a file with
// the "use server" directive may only export async functions, so a const/array
// export there breaks the Next.js build.
export const EXPENSE_CATEGORIES = [
  'servicios',
  'arriendo',
  'transporte',
  'marketing',
  'impuestos',
  'otros',
] as const;
