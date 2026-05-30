'use client';

import { Link, usePathname } from '@/libs/I18nNavigation';
import { Logo } from '@/templates/Logo';
import { cn } from '@/utils/Helpers';
import { isNavActive, navGroups } from './navItems';

/**
 * Sidebar fija del dashboard (Tienda Control). Visible en lg+, oculta en móvil
 * (donde la navegación vive en el menú desplegable del topbar).
 */
export const DashboardSidebar = (props: { cashBadge?: 'red' | null }) => {
  const pathname = usePathname();

  return (
    <aside className="
      hidden w-60 shrink-0 flex-col border-r border-border bg-card
      lg:flex
    "
    >
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link href="/dashboard">
          <Logo />
        </Link>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {navGroups.map(group => (
          <div key={group.title}>
            <div className="
              mb-1 px-2 text-[11px] font-semibold tracking-wider
              text-muted-foreground uppercase
            "
            >
              {group.title}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isNavActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        `
                          flex h-9 items-center gap-2.5 rounded-lg px-2.5
                          text-sm font-medium text-muted-foreground
                          transition-colors
                          hover:bg-accent hover:text-foreground
                        `,
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
                      <span className="truncate">{item.label}</span>
                      {item.href === '/dashboard/cash' && props.cashBadge === 'red' && (
                        <span
                          className="ml-auto size-2 rounded-full bg-destructive"
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
