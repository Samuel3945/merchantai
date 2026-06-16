/**
 * Pure client-side validation for the "Registrar gasto" form.
 * Returns an error string if invalid, or null if valid.
 * No React, no DB — testable without a browser.
 */
export type GastoFields = {
  fromAccountId: string;
  amount: string;
  category: string;
};

export function validateGasto(fields: GastoFields): string | null {
  if (!fields.fromAccountId) {
    return 'Seleccioná el contenedor de origen (Desde)';
  }
  if (!fields.category?.trim()) {
    return 'La categoría del gasto es requerida';
  }
  const amt = Number.parseFloat(fields.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return 'Ingresá un monto mayor a cero';
  }
  return null;
}
