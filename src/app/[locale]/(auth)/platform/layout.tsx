import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ConfirmProvider } from '@/components/ui/confirm-provider';
import { Link } from '@/libs/I18nNavigation';
import { getPlatformOperator } from '@/libs/platform/operator';

export const metadata: Metadata = {
  title: 'Consola de plataforma',
};

type PlatformLayoutProps = {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
};

/**
 * Operator-only shell. Non-operators are bounced to their dashboard; the data
 * layer (getPlatformDb) re-checks the gate on every query, so this redirect is
 * UX, not the security boundary.
 */
export default async function PlatformLayout(props: PlatformLayoutProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const operator = await getPlatformOperator();
  if (!operator) {
    redirect('/dashboard');
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="
          mx-auto flex max-w-6xl items-center justify-between px-4 py-3
        "
        >
          <div className="flex items-center gap-3">
            <span className="
              rounded-md bg-foreground px-2 py-1 text-xs font-bold tracking-wide
              text-background uppercase
            "
            >
              Plataforma
            </span>
            <span className="text-sm text-muted-foreground">
              Consola de operador
            </span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/platform"
              className="
                font-medium
                hover:underline
              "
            >
              Resumen
            </Link>
            <Link
              href="/platform/businesses"
              className="
                font-medium
                hover:underline
              "
            >
              Negocios
            </Link>
            <Link
              href="/platform/plans"
              className="
                font-medium
                hover:underline
              "
            >
              Planes
            </Link>
            <Link
              href="/platform/creditos"
              className="
                font-medium
                hover:underline
              "
            >
              Créditos
            </Link>
            <Link
              href="/platform/alerts"
              className="
                font-medium
                hover:underline
              "
            >
              Alertas
            </Link>
            <Link
              href="/dashboard"
              className="
                text-muted-foreground
                hover:underline
              "
            >
              Volver al dashboard
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <ConfirmProvider>{props.children}</ConfirmProvider>
      </main>
    </div>
  );
}
