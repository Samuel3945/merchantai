import { setRequestLocale } from 'next-intl/server';
import { getMyContact } from '@/actions/employees';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { MyProfileClient } from '@/features/profile/MyProfileClient';

export default async function DashboardMiPerfilPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { phone, hasProfile } = await getMyContact();

  return (
    <>
      <TitleBar
        title="Mi perfil"
        description="Tus datos de contacto para la comunicación interna con el asistente."
      />
      <MyProfileClient initialPhone={phone} hasProfile={hasProfile} />
    </>
  );
}

export const dynamic = 'force-dynamic';
