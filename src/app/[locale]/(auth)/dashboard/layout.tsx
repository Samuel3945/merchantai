import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { getFraudAlerts } from '@/actions/cash';
import { DashboardHeader } from '@/features/dashboard/DashboardHeader';
import { DashboardSidebar } from '@/features/dashboard/DashboardSidebar';
import { buildNavGroups } from '@/features/dashboard/navItems';

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
  const { orgId, orgRole } = await auth();
  if (orgId && orgRole === 'org:admin') {
    const setting = await getAppSetting('onboarding_completed');
    if (setting.value !== 'true') {
      redirect('/onboarding');
    }
  }

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
  // reflects exactly what the business has enabled in settings.
  const [fiadoSetting, employeesSetting] = await Promise.all([
    getAppSetting('fiado-enabled'),
    getAppSetting('modules.employees'),
  ]);
  const navGroupsForOrg = buildNavGroups({
    fiado: fiadoSetting.value !== 'false', // defaults to enabled
    employees: employeesSetting.value === 'true',
  });

  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar cashBadge={cashBadge} groups={navGroupsForOrg} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="
          sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border
          bg-card px-4
        "
        >
          <DashboardHeader cashBadge={cashBadge} groups={navGroupsForOrg} />
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
