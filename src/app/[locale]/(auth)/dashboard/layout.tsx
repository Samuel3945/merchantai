import type { Metadata } from 'next';
import type { NavModuleFlags } from '@/features/dashboard/navItems';
import { auth } from '@clerk/nextjs/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { getFraudAlerts } from '@/actions/cash';
import { DashboardHeader } from '@/features/dashboard/DashboardHeader';
import { DashboardSidebar } from '@/features/dashboard/DashboardSidebar';
import { getPanelUserModules } from '@/libs/panel-session';

type DashboardLayoutProps = {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
};

export async function generateMetadata(props: DashboardLayoutProps): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({
    locale,
    namespace: 'DashboardLayout',
  });

  return {
    title: t('meta_title'),
    description: t('meta_description'),
  };
}

export default async function DashboardLayout(props: DashboardLayoutProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Onboarding gate — only org admins need to complete the wizard.
  // Cashiers/employees consume the POS, not the dashboard, so they aren't redirected.
  const { userId, orgId, orgRole } = await auth();
  const isOwner = orgRole === 'org:admin';
  if (orgId && isOwner) {
    const setting = await getAppSetting('onboarding_completed');
    if (setting.value !== 'true') {
      redirect('/onboarding');
    }
  }

  // Per-user panel permissions. The owner (org admin) sees everything → null.
  // A non-owner member's allowed modules are resolved from the DB (source of
  // truth); deny-by-default to an empty set if they have no linked active user.
  // Route-level enforcement also lives in the middleware; this only drives nav.
  const panelModules: string[] | null
    = orgId && !isOwner && userId
      ? ((await getPanelUserModules(userId, orgId)) ?? [])
      : null;

  // Fraud-alert badge for the Caja menu item. Failures are non-fatal —
  // we never want a layout to crash because the alert query failed.
  let cashBadge: 'red' | null = null;
  if (orgId) {
    try {
      const alerts = await getFraudAlerts(14);
      if (alerts.some(a => a.severity === 'high')) {
        cashBadge = 'red';
      }
    } catch {
      cashBadge = null;
    }
  }

  // Module-gated nav: hide Fiados/Empleados when their toggle is off so the menu
  // reflects exactly what the business has enabled in settings. We pass plain
  // booleans (not the built groups) because the nav groups carry Lucide icon
  // components, which cannot cross the Server→Client boundary as props. The
  // client nav components filter locally via buildNavGroups.
  const [fiadoSetting, employeesSetting] = await Promise.all([
    getAppSetting('fiado-enabled'),
    getAppSetting('modules.employees'),
  ]);
  const navFlags: NavModuleFlags = {
    fiado: fiadoSetting.value !== 'false', // defaults to enabled
    employees: employeesSetting.value === 'true',
  };

  // Sidebar collapsed/expanded preference, resolved server-side so the first
  // paint matches the user's last choice (no hydration flash).
  const cookieStore = await cookies();
  const sidebarCollapsed = cookieStore.get('sidebar-collapsed')?.value === 'true';

  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar
        cashBadge={cashBadge}
        navFlags={navFlags}
        panelModules={panelModules}
        defaultCollapsed={sidebarCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="
          sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border
          bg-card px-4
        "
        >
          <DashboardHeader
            cashBadge={cashBadge}
            navFlags={navFlags}
            panelModules={panelModules}
          />
        </header>

        <main className="
          flex-1 px-4 py-6
          sm:px-6
          lg:px-8
        "
        >
          <div className="mx-auto max-w-7xl">
            {props.children}
          </div>
        </main>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
