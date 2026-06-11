import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { listExpenses } from '@/actions/expenses';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { ExpensesClient } from '@/features/expenses/ExpensesClient';

export default async function DashboardExpensesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Owner-only gate: only org:admin may access expense data.
  const { orgRole } = await auth();
  if (orgRole !== 'org:admin') {
    redirect('/dashboard');
  }

  // Default to current calendar month in Bogota local time (America/Bogota, UTC-5).
  const bogotaFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' });
  const todayBogota = bogotaFmt.format(new Date()); // YYYY-MM-DD
  const [year, month] = todayBogota.split('-').map(Number);
  const defaultStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // Last day of the current Bogota month.
  const lastDay = new Date(Date.UTC(year ?? 1970, month ?? 1, 0)).getUTCDate();
  const defaultEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const expenses = await listExpenses({ start: defaultStart, end: defaultEnd });

  return (
    <>
      <TitleBar
        title="Gastos operativos"
        description="Registrá los gastos del negocio para calcular la utilidad neta real."
      />
      <ExpensesClient
        initialExpenses={expenses}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
