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

  // If the org has already completed onboarding, send the admin to the dashboard.
  const done = await getAppSetting('onboarding_completed');
  if (done.value === 'true') {
    redirect('/dashboard');
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
