import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { OnboardingStepper } from '@/features/onboarding/OnboardingStepper';

type OnboardingPageProps = {
  params: Promise<{ locale: string }>;
};

export default async function OnboardingPage(props: OnboardingPageProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // The wizard's first step creates the organization, so a brand-new merchant
  // reaches this page with no active org yet. Only check completion once an org
  // exists — getAppSetting requires one and would otherwise throw.
  const { orgId } = await auth();
  if (orgId) {
    const done = await getAppSetting('onboarding_completed');
    if (done.value === 'true') {
      redirect('/dashboard');
    }
  }

  return (
    <div className="min-h-screen bg-muted">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <OnboardingStepper />
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
