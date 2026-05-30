import { setRequestLocale } from 'next-intl/server';
import { listEmployees, listPendingInvitations } from '@/actions/employees';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { EmployeesClient } from '@/features/employees/EmployeesClient';

export default async function DashboardEmployeesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [employees, invitations] = await Promise.all([
    listEmployees(),
    listPendingInvitations(),
  ]);

  return (
    <>
      <TitleBar
        title="Empleados"
        description="Invita cajeros y empleados, gestiona roles, permisos y módulos."
      />
      <EmployeesClient
        initialEmployees={employees}
        initialInvitations={invitations}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
