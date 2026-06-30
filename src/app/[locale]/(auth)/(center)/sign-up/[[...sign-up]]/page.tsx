import type { Metadata } from 'next';
import { SignUp } from '@clerk/nextjs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getI18nPath } from '@/utils/Helpers';

type SignUpPageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata(props: SignUpPageProps): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({
    locale,
    namespace: 'SignUp',
  });

  return {
    title: t('meta_title'),
    description: t('meta_description'),
  };
}

export default async function SignUpPage(props: SignUpPageProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <div className="flex flex-col items-center gap-4">
      <SignUp path={getI18nPath('/sign-up', locale)} />
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Al registrarte aceptas nuestros
        {' '}
        <a
          href="https://mymerchantai.com/terminos"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Términos de Servicio
        </a>
        {' '}
        y nuestra
        {' '}
        <a
          href="https://mymerchantai.com/privacidad"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Política de Privacidad
        </a>
        .
      </p>
    </div>
  );
};
