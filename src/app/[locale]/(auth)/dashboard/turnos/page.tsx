import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getTodayRoster, listAbsences } from '@/actions/coverage';
import { listEmployees } from '@/actions/employees';
import { CoverageClient } from '@/features/coverage/CoverageClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardTurnosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Owner-only gate — same pattern as expenses/page.tsx.
  const { orgRole } = await auth();
  if (orgRole !== 'org:admin') {
    redirect('/dashboard');
  }

  // Today in America/Bogota local time.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

  // Rolling 30-day window for absences.
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  const thirtyDaysAhead = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(d);

  const [roster, absencesResult, employeeRows] = await Promise.all([
    getTodayRoster(),
    listAbsences({ start: today, end: thirtyDaysAhead }),
    listEmployees(),
  ]);
  const absences = absencesResult.ok ? absencesResult.data : [];

  // Pass a minimal employee list (id + name) for the register form selector.
  const employees = employeeRows
    .filter(e => e.active)
    .map(e => ({ id: e.id, name: e.name }));

  return (
    <>
      <TitleBar
        title="Turnos y cobertura"
        description="Controlá quién trabaja hoy, registrá ausencias y asigná reemplazos."
      />
      <CoverageClient
        initialRoster={roster}
        initialAbsences={absences}
        employees={employees}
        defaultDate={today}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
