import type { NavModuleFlags } from './navItems';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buildNavGroups, navGroups } from './navItems';

/**
 * Navegación móvil: replica los grupos de la sidebar en un menú desplegable.
 */
export const MobileNavigation = (props: {
  cashBadge?: 'red' | null;
  navFlags?: NavModuleFlags;
  /** Non-owner member's allowed modules; null/undefined = owner (sees all). */
  panelModules?: string[] | null;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        className="
          relative p-2
          focus-visible:ring-offset-0
        "
        variant="ghost"
        aria-label="Abrir menú"
      >
        <svg
          className="size-6 stroke-current"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M0 0h24v24H0z" stroke="none" />
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        {props.cashBadge === 'red' && (
          <span
            className="
              absolute top-1 right-1 size-2 rounded-full bg-destructive ring-2
              ring-card
            "
            aria-label="Alerta de caja"
          />
        )}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56">
      {(props.navFlags ? buildNavGroups(props.navFlags, props.panelModules) : navGroups).map((group, i) => (
        <div key={group.title}>
          {i > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="
            text-[11px] tracking-wider text-muted-foreground uppercase
          "
          >
            {group.title}
          </DropdownMenuLabel>
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem key={item.href} asChild>
                <Link
                  href={item.href}
                  className="flex items-center gap-2.5"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                  {item.href === '/dashboard/cash' && props.cashBadge === 'red' && (
                    <span
                      className="ml-auto size-2 rounded-full bg-destructive"
                      aria-label="Alerta de caja"
                    />
                  )}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </div>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
