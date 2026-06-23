import { auth, clerkClient } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { OnboardingStepper } from '@/features/onboarding/OnboardingStepper';
import { isOnboardingForced } from '@/libs/platform/global-settings';
import { getPlatformOperator } from '@/libs/platform/operator';

type OnboardingPageProps = {
  params: Promise<{ locale: string }>;
};

export default async function OnboardingPage(props: OnboardingPageProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { userId, orgId } = await auth();

  // Invited employees already belong to an org — a Clerk membership is created
  // when they accept the invitation. If their session has no ACTIVE org yet
  // (Clerk's "auto-set active organization" may be off), they must NOT see the
  // create-a-business wizard. Send them to pick/activate the org they were
  // invited to instead, so an employee never creates a stray business. Runs in
  // both modes, before the gate below.
  if (!orgId && userId) {
    const memberships = await (
      await clerkClient()
    ).users.getOrganizationMembershipList({ userId, limit: 1 });
    if (memberships.totalCount > 0) {
      redirect('/onboarding/organization-selection');
    }
  }

  if (await isOnboardingForced()) {
    // Forced mode (original behavior): skip the wizard if this org already
    // finished it. A brand-new merchant has no org yet and falls through to the
    // wizard, whose first step creates the organization. getAppSetting requires
    // an org, so it only runs once one exists.
    if (orgId) {
      const done = await getAppSetting('onboarding_completed');
      if (done.value === 'true') {
        redirect('/dashboard');
      }
    }
  } else {
    // Onboarding is globally OFF → it becomes an operator-only testing surface.
    // An owner who already has an org doesn't need the wizard (everything lives
    // in Ajustes), so bounce everyone except the operator to the dashboard. A
    // user with NO org still falls through so they can create their first
    // business — that also avoids a redirect loop with the middleware, which
    // sends org-less users here.
    if (orgId) {
      const operator = await getPlatformOperator();
      if (!operator) {
        redirect('/dashboard');
      }
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
