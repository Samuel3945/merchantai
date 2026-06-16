/**
 * Pure client-side validation for the "Mover dinero" form.
 * Returns an error string if invalid, or null if valid.
 * No React, no DB — testable without a browser.
 */
export type MoverDineroFields = {
  fromId: string;
  toId: string;
  amount: string;
};

export function validateMoverDinero(fields: MoverDineroFields): string | null {
  if (!fields.fromId) {
    return 'Seleccioná el origen del movimiento';
  }
  if (!fields.toId) {
    return 'Seleccioná el destino del movimiento';
  }
  if (fields.fromId === fields.toId) {
    return 'El origen y el destino deben ser diferentes';
  }
  const amt = Number.parseFloat(fields.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return 'Ingresá un monto mayor a cero';
  }
  return null;
}
