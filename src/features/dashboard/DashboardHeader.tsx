import type { NavModuleFlags } from './navItems';
import { UserButton } from '@clerk/nextjs';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { BusinessSwitcher } from '@/components/BusinessSwitcher';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { NotificationBell } from '@/components/NotificationBell';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Separator } from '@/components/ui/separator';
import { Logo } from '@/templates/Logo';
import { getI18nPath } from '@/utils/Helpers';
import { MobileNavigation } from './MobileNavigation';
import { OrganizationMenu } from './OrganizationMenu';

/**
 * Topbar del dashboard (Tienda Control). La navegación principal vive en la
 * sidebar; aquí quedan el menú móvil, el selector de organización/negocio y
 * las acciones de usuario.
 */
export const DashboardHeader = (props: {
  cashBadge?: 'red' | null;
  navFlags?: NavModuleFlags;
}) => {
  const locale = useLocale();

  return (
    <>
      <div className="
        flex items-center gap-2
        lg:hidden
      "
      >
        <MobileNavigation cashBadge={props.cashBadge} navFlags={props.navFlags} />
        <Link href="/dashboard">
          <Logo isTextHidden />
        </Link>
      </div>

      <div className="
        hidden items-center
        lg:flex
      "
      >
        <OrganizationMenu />
      </div>

      <div className="ml-auto flex items-center gap-x-1.5">
        <BusinessSwitcher />

        <NotificationBell />

        <ThemeToggle />

        <LocaleSwitcher />

        <Separator orientation="vertical" className="h-4" />

        <UserButton
          userProfileMode="navigation"
          userProfileUrl={getI18nPath('/dashboard/user-profile', locale)}
          afterSwitchSessionUrl="/dashboard"
          appearance={{
            elements: {
              rootBox: 'px-1 py-1',
            },
          }}
        />
      </div>
    </>
  );
};
