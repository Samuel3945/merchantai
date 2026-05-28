import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { getFraudAlerts } from '@/actions/cash';
import { DashboardHeader } from '@/features/dashboard/DashboardHeader';

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

  const t = await getTranslations({
    locale,
    namespace: 'DashboardLayout',
  });

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

  return (
    <>
      <div className="shadow-md">
        <div className="
          mx-auto flex max-w-7xl items-center justify-between px-3 py-4
        "
        >
          <DashboardHeader
            menu={[
              {
                href: '/dashboard',
                label: t('home'),
              },
              {
                href: '/dashboard/organization-profile/organization-members',
                label: t('members'),
              },
              {
                href: '/dashboard/customers',
                label: 'Customers',
              },
              {
                href: '/dashboard/employees',
                label: 'Employees',
              },
              {
                href: '/dashboard/inventory',
                label: 'Inventario',
              },
              {
                href: '/dashboard/pos-cajeros',
                label: 'POS Cajeros',
              },
              {
                href: '/dashboard/cash',
                label: 'Caja',
                badge: cashBadge,
              },
              {
                href: '/dashboard/reports',
                label: 'Reportes',
              },
              {
                href: '/dashboard/plans',
                label: 'Plans',
              },
              {
                href: '/dashboard/ai-agent',
                label: 'AI Agent',
              },
              {
                href: '/dashboard/settings',
                label: t('settings'),
              },
            ]}
          />
        </div>
      </div>

      <div className="min-h-[calc(100vh-72px)] bg-muted">
        <div className="mx-auto max-w-7xl px-3 pt-6 pb-16">
          {props.children}
        </div>
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
