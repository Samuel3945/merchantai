import { auth, clerkClient } from '@clerk/nextjs/server';
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
  const { userId, orgId } = await auth();
  if (orgId) {
    const done = await getAppSetting('onboarding_completed');
    if (done.value === 'true') {
      redirect('/dashboard');
    }
  }

  // Invited employees already belong to an org — a Clerk membership is created
  // when they accept the invitation. If their session has no ACTIVE org yet
  // (Clerk's "auto-set active organization" may be off), they must NOT see the
  // create-a-business wizard. Send them to pick/activate the org they were
  // invited to instead, so an employee never creates a stray business.
  if (!orgId && userId) {
    const memberships = await (
      await clerkClient()
    ).users.getOrganizationMembershipList({ userId, limit: 1 });
    if (memberships.totalCount > 0) {
      redirect('/onboarding/organization-selection');
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
