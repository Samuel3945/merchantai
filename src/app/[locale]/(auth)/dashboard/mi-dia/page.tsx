import { auth } from '@clerk/nextjs/server';
import { Receipt, ShoppingBag, UserRound } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMyDay } from '@/actions/dashboard';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/features/dashboard/TitleBar';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export default async function MiDiaPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // "Mi día" is the employee home. Owners have the Resumen instead, so bounce
  // them back rather than showing an empty personal view.
  const { orgRole } = await auth();
  if (orgRole === 'org:admin') {
    redirect('/dashboard');
  }

  const myDay = await getMyDay();
  const firstName = myDay.name.trim().split(/\s+/)[0] || 'tu día';

  return (
    <>
      <TitleBar
        title={`Hola, ${firstName}`}
        description="Tu resumen del día. Solo ves tu propia información."
      />

      <div className="
        grid gap-4
        sm:grid-cols-2
      "
      >
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShoppingBag className="size-4" />
            Mis ventas hoy
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {moneyFmt.format(myDay.salesToday.total)}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Receipt className="size-4" />
            Transacciones de hoy
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {myDay.salesToday.count}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {myDay.canViewSales && (
          <Button asChild>
            <Link href="/dashboard/sales">Ver mis ventas</Link>
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href="/dashboard/mi-perfil">
            <UserRound className="size-4" />
            Mi perfil
          </Link>
        </Button>
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
