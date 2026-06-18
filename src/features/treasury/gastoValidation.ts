/**
 * Pure client-side validation for the "Registrar gasto" form.
 * Returns an error string if invalid, or null if valid.
 * No React, no DB — testable without a browser.
 */
export type GastoFields = {
  fromAccountId: string;
  amount: string;
  category: string;
  /** Required when category is 'otros'. Optional otherwise. */
  description?: string;
  /** ISO date string 'YYYY-MM-DD'. If omitted, defaults to today on submit. */
  incurredOn?: string;
};

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateGasto(fields: GastoFields): string | null {
  if (!fields.fromAccountId) {
    return 'Seleccioná el contenedor de origen (Desde)';
  }
  if (!fields.category?.trim()) {
    return 'La categoría del gasto es requerida';
  }
  // 'otros' requires a written reason — otherwise the expense is unauditable.
  if (fields.category.trim() === 'otros' && !fields.description?.trim()) {
    return 'Para la categoría "Otros" debés escribir el motivo del gasto';
  }
  const amt = Number.parseFloat(fields.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return 'Ingresá un monto mayor a cero';
  }
  if (fields.incurredOn !== undefined && !isValidDate(fields.incurredOn)) {
    return 'La fecha del gasto no es válida (usá YYYY-MM-DD)';
  }
  return null;
}
