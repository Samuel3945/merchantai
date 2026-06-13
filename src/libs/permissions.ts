/**
 * Single source of truth for the business permission model.
 *
 * Product rule (locked with the owner): there are NO fixed roles. There are only
 * USERS, and the owner grants each one whatever permissions they want. A
 * permission either unlocks a VIEW/MODULE or allows a sensitive ACTION. The same
 * grants govern every surface (POS and web panel), so this catalog is the one
 * place the whole app reads from. Every user gets web panel access — what they
 * SEE there is still limited to their granted modules.
 *
 * Granting "Caja registradora (POS)" pre-ticks the cashier core bundle
 * ({@link POS_CORE_MODULES}: caja, ventas, fiados, clientes) as a convenience —
 * the owner can untick. Conversely, unticking any core module drops the POS
 * grant, because a cashier needs the full bundle to operate the counter. Any
 * other module can still be granted alone without POS access.
 *
 * Source of truth = the database: `panel_access` + `enabled_modules` +
 * `permissions`. Clerk membership metadata is only a cached copy for fast
 * authorization.
 *
 * Storage split (kept for backward compatibility with the POS app):
 *  - `enabledModules` (text[])  -> the keys in {@link MODULE_PERMISSIONS}
 *  - `permissions`    (jsonb)   -> action key -> boolean, see {@link ACTION_PERMISSIONS}
 */

type PermissionItem = {
  /** Stable key persisted in the database. Never change once shipped. */
  key: string;
  /** Human label shown to the owner when granting access. */
  label: string;
  /** Optional one-line hint shown under the label. */
  hint?: string;
  /**
   * Dashboard route this module unlocks, if any. `pos` has none — it unlocks the
   * separate /pos app, not a dashboard view.
   */
  dashboardPath?: string;
};

/**
 * Grantable views/modules. Existing keys (pos, inventory, reports, fiados) MUST
 * stay unchanged so current POS accounts keep working; new panel modules follow
 * the same English-key convention.
 */
export const MODULE_PERMISSIONS: PermissionItem[] = [
  { key: 'pos', label: 'Caja registradora (POS)', hint: 'Operar la app de caja. Activa el combo de cajero: Caja, Ventas, Fiados y Clientes (puedes desmarcar).' },
  { key: 'cash', label: 'Caja', hint: 'Arqueo y movimientos de caja', dashboardPath: '/dashboard/cash' },
  { key: 'sales', label: 'Ventas', hint: 'Historial de ventas', dashboardPath: '/dashboard/sales' },
  { key: 'fiados', label: 'Fiados', hint: 'Cuentas por cobrar', dashboardPath: '/dashboard/fiados' },
  { key: 'products', label: 'Productos', hint: 'Catálogo de productos', dashboardPath: '/dashboard/products' },
  { key: 'inventory', label: 'Inventario', hint: 'Ver y mover stock', dashboardPath: '/dashboard/inventory' },
  { key: 'customers', label: 'Clientes', hint: 'Base de clientes', dashboardPath: '/dashboard/customers' },
  { key: 'suppliers', label: 'Proveedores', hint: 'Base de proveedores', dashboardPath: '/dashboard/suppliers' },
  { key: 'reports', label: 'Reportes', hint: 'Reportes del negocio', dashboardPath: '/dashboard/reports' },
  { key: 'delivery', label: 'Domicilios', hint: 'Pedidos a domicilio para el domiciliario', dashboardPath: '/dashboard/delivery' },
  { key: 'facturas', label: 'Facturas', hint: 'Facturación electrónica (DIAN)', dashboardPath: '/dashboard/facturas' },
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
 * The cashier "core" bundle. Granting `pos` pre-ticks exactly these modules, and
 * unticking any of them drops the `pos` grant — a cashier needs the full set to
 * operate the counter. Keys must exist in {@link MODULE_PERMISSIONS}.
 */
export const POS_CORE_MODULES: string[] = ['cash', 'sales', 'fiados', 'customers'];

// Dashboard routes reserved for the owner (Clerk org admin). Members are never
// granted these; deny-by-default also covers any unmapped dashboard route.
const OWNER_ONLY_PREFIXES = [
  '/dashboard/pos-cajeros',
  '/dashboard/employees',
  '/dashboard/expenses',
  '/dashboard/plans',
  '/dashboard/settings',
  '/dashboard/ai-agent',
];

// Dashboard routes any panel user may open regardless of modules. "Mi día" is
// the member home that replaces the owner-only Resumen for non-owners.
const PANEL_PUBLIC_PREFIXES = [
  '/dashboard/mi-dia',
  '/dashboard/user-profile',
  '/dashboard/mi-perfil',
];

type PathRequirement
  = | { kind: 'public' }
    | { kind: 'owner' }
    | { kind: 'module'; module: string };

/** Extracts the path starting at `/dashboard`, dropping any locale prefix. */
function dashboardPath(pathname: string): string | null {
  const idx = pathname.indexOf('/dashboard');
  return idx === -1 ? null : pathname.slice(idx);
}

/**
 * Resolves what a given path requires from a non-owner panel user. The Resumen
 * landing (`/dashboard` exact) is OWNER-ONLY — it shows business-wide metrics, so
 * members are bounced to their "Mi día" home. Known module routes require their
 * module; everything else under /dashboard is owner-only (deny-by-default).
 */
export function requiredModuleForPath(pathname: string): PathRequirement {
  const path = dashboardPath(pathname);
  if (path === null) {
    return { kind: 'public' };
  }
  if (path === '/dashboard' || path === '/dashboard/') {
    return { kind: 'owner' };
  }
  if (PANEL_PUBLIC_PREFIXES.some(p => path.startsWith(p))) {
    return { kind: 'public' };
  }
  const mod = MODULE_PERMISSIONS.find(
    m => m.dashboardPath && path.startsWith(m.dashboardPath),
  );
  if (mod) {
    return { kind: 'module', module: mod.key };
  }
  if (OWNER_ONLY_PREFIXES.some(p => path.startsWith(p))) {
    return { kind: 'owner' };
  }
  return { kind: 'owner' };
}

/** True when a user with these grants can access a module/view. */
export function canAccessModule(
  enabledModules: string[] | null | undefined,
  moduleKey: string,
): boolean {
  return (enabledModules ?? []).includes(moduleKey);
}

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
