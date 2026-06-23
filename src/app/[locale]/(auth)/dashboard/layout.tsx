import type { Metadata } from 'next';
import type { NavModuleFlags } from '@/features/dashboard/navItems';
import { auth } from '@clerk/nextjs/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { getFraudAlerts } from '@/actions/cash';
import { ConfirmProvider } from '@/components/ui/confirm-provider';
import { DashboardHeader } from '@/features/dashboard/DashboardHeader';
import { DashboardSidebar } from '@/features/dashboard/DashboardSidebar';
import { ImpersonationBanner } from '@/features/dashboard/ImpersonationBanner';
import { getPanelUserModules } from '@/libs/panel-session';
import { isOnboardingForced } from '@/libs/platform/global-settings';

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

  // Onboarding gate — only org admins need to complete the wizard, and only
  // while the platform operator keeps onboarding FORCED (global switch in
  // /platform). It defaults OFF: the operator configures businesses directly in
  // Ajustes, so the wizard never blocks the dashboard. Cashiers/employees
  // consume the POS, not the dashboard, so they aren't redirected.
  const { userId, orgId, orgRole } = await auth();
  const isOwner = orgRole === 'org:admin';
  if (orgId && isOwner && (await isOnboardingForced())) {
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

  // Sin-ubicar badge for the Tesorería menu item. Non-fatal — layout never crashes.
  let pendingHandoversBadge = false;
  if (orgId && isOwner) {
    try {
      const { getPendingHandoversOverview } = await import('@/actions/treasury-placement');
      const overview = await getPendingHandoversOverview();
      pendingHandoversBadge = overview.ok && overview.data.count > 0;
    } catch {
      pendingHandoversBadge = false;
    }
  }

  // Module-gated nav: hide Fiados/Empleados when their toggle is off so the menu
  // reflects exactly what the business has enabled in settings. We pass plain
  // booleans (not the built groups) because the nav groups carry Lucide icon
  // components, which cannot cross the Server→Client boundary as props. The
  // client nav components filter locally via buildNavGroups.
  const [
    fiadoSetting,
    employeesSetting,
    deliverySetting,
    facturasSetting,
    suppliersSetting,
    aiSetting,
  ] = await Promise.all([
    getAppSetting('fiado-enabled'),
    getAppSetting('modules.employees'),
    getAppSetting('modules.delivery'),
    getAppSetting('modules.facturas'),
    getAppSetting('modules.suppliers'),
    getAppSetting('modules.ai'),
  ]);
  // Most modules default to ENABLED; the owner opts out in Ajustes → Módulos.
  // The AI preview is the exception: it defaults OFF and is enabled per-org by
  // the operator from /platform. Domicilios rides with it (the agent's phase-2
  // use case), so it stays hidden until AI preview is on AND its own toggle is.
  const aiEnabled = aiSetting.value === 'true';
  const navFlags: NavModuleFlags = {
    fiado: fiadoSetting.value !== 'false',
    employees: employeesSetting.value !== 'false',
    delivery: aiEnabled && deliverySetting.value !== 'false',
    facturas: facturasSetting.value !== 'false',
    suppliers: suppliersSetting.value !== 'false',
    ai: aiEnabled,
  };

  // Sidebar collapsed/expanded preference, resolved server-side so the first
  // paint matches the user's last choice (no hydration flash).
  const cookieStore = await cookies();
  const sidebarCollapsed = cookieStore.get('sidebar-collapsed')?.value === 'true';

  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar
        cashBadge={cashBadge}
        pendingHandoversBadge={pendingHandoversBadge}
        navFlags={navFlags}
        panelModules={panelModules}
        defaultCollapsed={sidebarCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ImpersonationBanner />
        <header className="
          sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border
          bg-card px-4
        "
        >
          <DashboardHeader
            cashBadge={cashBadge}
            pendingHandoversBadge={pendingHandoversBadge}
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
            <ConfirmProvider>{props.children}</ConfirmProvider>
          </div>
        </main>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
