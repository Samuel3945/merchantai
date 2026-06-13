import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getMyContact } from '@/actions/employees';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { MyProfileClient } from '@/features/profile/MyProfileClient';

export default async function DashboardMiPerfilPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // The owner has no posUsers row — this personal view does not apply to them.
  // Their business contact number lives in Ajustes → Negocio instead.
  const { orgRole } = await auth();
  if (orgRole === 'org:admin') {
    redirect('/dashboard');
  }

  const { phone, hasProfile, canCashier, hasPin } = await getMyContact();

  return (
    <>
      <TitleBar
        title="Mi perfil"
        description="Tus datos de contacto para la comunicación interna con el asistente."
      />
      <MyProfileClient
        initialPhone={phone}
        hasProfile={hasProfile}
        canCashier={canCashier}
        initialHasPin={hasPin}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
