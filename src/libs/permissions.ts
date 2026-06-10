/**
 * Single source of truth for the business permission model.
 *
 * Product rule (decided with the owner): there are NO fixed role tiers. There
 * are only USERS, and the business owner grants each one whatever permissions
 * they want. A permission either unlocks a VIEW/MODULE or allows a sensitive
 * ACTION. The same grants govern every surface (POS and dashboard), so this
 * catalog is the one place the whole app reads from.
 *
 * Storage split (kept for backward compatibility with the POS app):
 *  - `enabledModules` (text[])  -> the keys in {@link MODULE_PERMISSIONS}
 *  - `permissions`    (jsonb)   -> action key -> boolean, see {@link ACTION_PERMISSIONS}
 *
 * Both are projections of the same checklist the owner ticks in the UI.
 */

type PermissionItem = {
  /** Stable key persisted in the database. Never change once shipped. */
  key: string;
  /** Human label shown to the owner when granting access. */
  label: string;
  /** Optional one-line hint shown under the label. */
  hint?: string;
};

/**
 * Views/modules a user can open. Keys MUST match what the POS app already
 * reads from `enabledModules`, so existing cashier accounts keep working.
 */
export const MODULE_PERMISSIONS: PermissionItem[] = [
  { key: 'pos', label: 'Caja registradora (POS)', hint: 'Vender desde la app de caja' },
  { key: 'inventory', label: 'Inventario', hint: 'Ver y mover stock' },
  { key: 'reports', label: 'Reportes', hint: 'Ver reportes del negocio' },
  { key: 'fiados', label: 'Fiados', hint: 'Gestionar cuentas por cobrar' },
];

/** Sensitive actions, persisted in the `permissions` jsonb as key -> true. */
export const ACTION_PERMISSIONS: PermissionItem[] = [
  { key: 'sales.refund', label: 'Reembolsar ventas' },
  { key: 'cash.withdraw', label: 'Retirar efectivo' },
  { key: 'cash.adjust', label: 'Ajustar conteos de caja' },
  { key: 'inventory.edit', label: 'Editar inventario' },
  { key: 'reports.view', label: 'Ver reportes' },
];

const MODULE_KEYS = MODULE_PERMISSIONS.map(p => p.key);
const ACTION_KEYS = ACTION_PERMISSIONS.map(p => p.key);

/**
 * Normalizes a free-form permissions map to only the known action keys set to
 * `true`. Drops unknown keys and falsy values so storage stays clean.
 */
export function cleanActionPermissions(
  input: Record<string, unknown> | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of ACTION_KEYS) {
    if (input?.[key]) {
      out[key] = true;
    }
  }
  return out;
}

/** Keeps only recognized module keys, preserving catalog order. */
export function cleanEnabledModules(
  input: string[] | null | undefined,
): string[] {
  const set = new Set(input ?? []);
  return MODULE_KEYS.filter(key => set.has(key));
}
