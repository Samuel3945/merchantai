'use client';

import type { NavModuleFlags } from './navItems';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';
import { Link, usePathname } from '@/libs/I18nNavigation';
import { Logo } from '@/templates/Logo';
import { cn } from '@/utils/Helpers';
import { buildNavGroups, isNavActive, navGroups } from './navItems';

// Persisted as a cookie so the server can render the correct width on first
// paint (no hydration mismatch, no flash). One year, path-wide.
const COOKIE_KEY = 'sidebar-collapsed';

/**
 * Sidebar fija del dashboard (Tienda Control). Visible en lg+, oculta en móvil
 * (donde la navegación vive en el menú desplegable del topbar).
 *
 * Se puede colapsar a un riel de solo iconos (acceso rápido). La preferencia
 * llega pre-resuelta desde el servidor vía `defaultCollapsed` (cookie), y cada
 * toggle reescribe la cookie para la próxima carga.
 */
export const DashboardSidebar = (props: {
  cashBadge?: 'red' | null;
  navFlags?: NavModuleFlags;
  /** Non-owner member's allowed modules; null/undefined = owner (sees all). */
  panelModules?: string[] | null;
  defaultCollapsed?: boolean;
}) => {
  const pathname = usePathname();
  const groups = props.navFlags
    ? buildNavGroups(props.navFlags, props.panelModules)
    : navGroups;

  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      document.cookie = `${COOKIE_KEY}=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };

  return (
    <aside
      className={cn(
        `
          hidden shrink-0 flex-col border-r border-border bg-card
          transition-[width] duration-200
          lg:flex
        `,
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center border-b border-border',
          collapsed ? 'justify-center px-2' : 'justify-between px-4',
        )}
      >
        {!collapsed && (
          <Link href="/dashboard">
            <Logo />
          </Link>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          className="
            flex size-8 items-center justify-center rounded-lg
            text-muted-foreground transition-colors
            hover:bg-accent hover:text-foreground
          "
        >
          {collapsed
            ? <PanelLeftOpen className="size-[18px]" />
            : <PanelLeftClose className="size-[18px]" />}
        </button>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {groups.map(group => (
          <div key={group.title}>
            {!collapsed && (
              <div className="
                mb-1 px-2 text-[11px] font-semibold tracking-wider
                text-muted-foreground uppercase
              "
              >
                {group.title}
              </div>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isNavActive(pathname, item.href);
                const Icon = item.icon;
                const showCashBadge
                  = item.href === '/dashboard/cash' && props.cashBadge === 'red';
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        `
                          relative flex h-9 items-center gap-2.5 rounded-lg
                          text-sm font-medium text-muted-foreground
                          transition-colors
                          hover:bg-accent hover:text-foreground
                        `,
                        collapsed ? 'justify-center px-0' : 'px-2.5',
                        active
                        && `
                          bg-brand-soft text-brand-ink
                          hover:bg-brand-soft hover:text-brand-ink
                        `,
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-[18px] shrink-0',
                          active ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {showCashBadge && (
                        <span
                          className={cn(
                            'size-2 rounded-full bg-destructive',
                            collapsed ? 'absolute top-1.5 right-1.5' : 'ml-auto',
                          )}
                          aria-label="Alerta de caja"
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
};
