import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { listConversations } from '@/features/conversations/actions';
import { ConversationsClient } from '@/features/conversations/ConversationsClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardConversacionesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Same gate as the AI agent page: the inbox only makes sense with the
  // WhatsApp agent enabled, a per-org preview flag flipped from /platform.
  const aiSetting = await getAppSetting('modules.ai');
  if (aiSetting.value !== 'true') {
    redirect('/dashboard');
  }

  const { orgRole } = await auth();
  const isAdmin = !orgRole || orgRole === 'org:admin';

  return (
    <>
      <TitleBar
        title="Conversaciones"
        description="Tomá el control del bot, atendé vos y bloqueá números desde acá."
      />

      {isAdmin
        ? (
            <ConversationsClient initial={await listConversations()} />
          )
        : (
            <div className="
              rounded-lg border border-dashed bg-background p-8 text-center
              text-sm text-muted-foreground
            "
            >
              Solo un administrador puede gestionar las conversaciones de WhatsApp.
            </div>
          )}
    </>
  );
}

export const dynamic = 'force-dynamic';
