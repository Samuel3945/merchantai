import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Boxes,
  CreditCard,
  HandCoins,
  LayoutDashboard,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Sparkles,
  Truck,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';

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
      { href: '/dashboard', label: 'Resumen', icon: LayoutDashboard },
      { href: '/dashboard/cash', label: 'Caja', icon: Wallet },
      { href: '/dashboard/sales', label: 'Ventas', icon: Receipt },
      { href: '/dashboard/pos-cajeros', label: 'Cajas POS', icon: ShoppingCart },
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
      { href: '/dashboard/reports', label: 'Reportes', icon: BarChart3 },
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
];

export type NavModuleFlags = {
  fiado: boolean;
  employees: boolean;
};

// Maps a nav href to the module flag that controls its visibility. Items not
// listed here are always visible (core modules).
const GATED_HREF: Record<string, keyof NavModuleFlags> = {
  '/dashboard/fiados': 'fiado',
  '/dashboard/employees': 'employees',
};

// Returns the nav groups with module-gated items removed when their flag is off.
// Empty groups are dropped so the sidebar never shows an empty section header.
export function buildNavGroups(flags: NavModuleFlags): NavGroup[] {
  return navGroups
    .map(group => ({
      ...group,
      items: group.items.filter((item) => {
        const flag = GATED_HREF[item.href];
        return flag ? flags[flag] : true;
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
