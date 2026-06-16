import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bike,
  Boxes,
  CreditCard,
  HandCoins,
  LayoutDashboard,
  Package,
  Receipt,
  ReceiptText,
  Settings,
  ShoppingCart,
  Sparkles,
  Sun,
  TrendingDown,
  Truck,
  UserCog,
  UserRound,
  Users,
  Vault,
  Wallet,
} from 'lucide-react';
import { requiredModuleForPath } from '@/libs/permissions';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

/**
 * Navegación del dashboard agrupada al estilo Tienda Control.
 * El core gratis (operación, catálogo, personas, negocio) va primero;
 * el Asistente IA queda aparte porque los módulos inteligentes llegan después.
 */
export const navGroups: NavGroup[] = [
  {
    title: 'Operación',
    items: [
      { href: '/dashboard/mi-dia', label: 'Mi día', icon: Sun },
      { href: '/dashboard', label: 'Resumen', icon: LayoutDashboard },
      { href: '/dashboard/cash', label: 'Caja', icon: Wallet },
      { href: '/dashboard/tesoreria', label: 'Tesorería', icon: Vault },
      { href: '/dashboard/sales', label: 'Ventas', icon: Receipt },
      { href: '/dashboard/pos-cajeros', label: 'Cajas POS', icon: ShoppingCart },
      { href: '/dashboard/delivery', label: 'Domicilios', icon: Bike },
      { href: '/dashboard/fiados', label: 'Fiados', icon: HandCoins },
    ],
  },
  {
    title: 'Catálogo',
    items: [
      { href: '/dashboard/products', label: 'Productos', icon: Package },
      { href: '/dashboard/inventory', label: 'Inventario', icon: Boxes },
    ],
  },
  {
    title: 'Personas',
    items: [
      { href: '/dashboard/customers', label: 'Clientes', icon: Users },
      { href: '/dashboard/suppliers', label: 'Proveedores', icon: Truck },
      { href: '/dashboard/employees', label: 'Empleados', icon: UserCog },
    ],
  },
  {
    title: 'Negocio',
    items: [
      { href: '/dashboard/facturas', label: 'Facturas', icon: ReceiptText },
      { href: '/dashboard/reports', label: 'Reportes', icon: BarChart3 },
      { href: '/dashboard/expenses', label: 'Gastos', icon: TrendingDown },
      { href: '/dashboard/plans', label: 'Planes', icon: CreditCard },
      { href: '/dashboard/settings', label: 'Ajustes', icon: Settings },
    ],
  },
  {
    title: 'Asistente IA',
    items: [
      { href: '/dashboard/ai-agent', label: 'Agente IA', icon: Sparkles },
    ],
  },
  {
    title: 'Cuenta',
    items: [
      { href: '/dashboard/mi-perfil', label: 'Mi perfil', icon: UserRound },
    ],
  },
];

export type NavModuleFlags = {
  fiado: boolean;
  employees: boolean;
  delivery: boolean;
  facturas: boolean;
  suppliers: boolean;
};

// Maps a nav href to the module flag that controls its visibility. Items not
// listed here are always visible (core modules).
const GATED_HREF: Record<string, keyof NavModuleFlags> = {
  '/dashboard/fiados': 'fiado',
  '/dashboard/employees': 'employees',
  '/dashboard/delivery': 'delivery',
  '/dashboard/facturas': 'facturas',
  '/dashboard/suppliers': 'suppliers',
};

// Personal views that only make sense for non-owner members. The owner is a
// Clerk member with no posUsers row, so "Mi perfil" (their WhatsApp) does not
// apply to them — their business number lives in Ajustes → Negocio instead.
// "Mi día" is the employee home that stands in for the owner-only Resumen.
const MEMBER_ONLY_HREFS = new Set<string>([
  '/dashboard/mi-dia',
  '/dashboard/mi-perfil',
]);

// Returns the nav groups with hidden items removed. Two filters apply:
//   1. Module toggles (NavModuleFlags) — business-level on/off (Fiados/Empleados).
//   2. Per-user panel permissions — when `panelModules` is provided (a non-owner
//      member), deny-by-default: keep only public items and the modules they
//      hold, hiding owner-only items. `panelModules == null` means the owner,
//      who sees everything the toggles allow.
// Empty groups are dropped so the sidebar never shows an empty section header.
export function buildNavGroups(
  flags: NavModuleFlags,
  panelModules?: string[] | null,
): NavGroup[] {
  return navGroups
    .map(group => ({
      ...group,
      items: group.items.filter((item) => {
        const flag = GATED_HREF[item.href];
        if (flag && !flags[flag]) {
          return false;
        }
        if (panelModules == null) {
          // Owner sees everything the toggles allow, except member-only views.
          return !MEMBER_ONLY_HREFS.has(item.href);
        }
        const need = requiredModuleForPath(item.href);
        if (need.kind === 'public') {
          return true;
        }
        if (need.kind === 'owner') {
          return false;
        }
        return panelModules.includes(need.module);
      }),
    }))
    .filter(group => group.items.length > 0);
}

/** Marca activo el item: exacto para Resumen, por prefijo para el resto. */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') {
    return pathname === '/dashboard' || pathname === '';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
