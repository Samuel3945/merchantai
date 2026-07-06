import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { db } from '@/libs/DB';
import { listOutstandingEmployeeLoans } from '@/libs/employee-loans';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: number): string {
  return cop.format(Number.isFinite(value) ? value : 0);
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export default async function DashboardEmployeeLoansPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { orgId } = await auth();
  const loans = orgId
    ? await listOutstandingEmployeeLoans(db, orgId)
    : [];

  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);

  return (
    <>
      <TitleBar
        title="Vales a empleados"
        description="Préstamos (vales) pendientes de pago. Los abonos se registran desde la caja."
      />

      {loans.length === 0
        ? (
            <div className="
              rounded-lg border border-dashed p-10 text-center text-sm
              text-muted-foreground
            "
            >
              No hay vales pendientes. Cuando entregues un vale a un empleado desde
              Caja → Salida, aparecerá acá.
            </div>
          )
        : (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Total pendiente:
                {' '}
                <span className="font-semibold text-foreground">
                  {money(totalOutstanding)}
                </span>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left">
                    <tr>
                      <th className="px-4 py-2 font-medium">Empleado</th>
                      <th className="px-4 py-2 text-right font-medium">Monto</th>
                      <th className="px-4 py-2 text-right font-medium">Pagado</th>
                      <th className="px-4 py-2 text-right font-medium">
                        Pendiente
                      </th>
                      <th className="px-4 py-2 font-medium">Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loans.map(loan => (
                      <tr
                        key={loan.loanId}
                        className="
                          border-b
                          last:border-0
                        "
                      >
                        <td className="px-4 py-2">
                          {loan.employeeName ?? 'Sin identificar'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {money(loan.totalAmount)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {money(loan.paidAmount)}
                        </td>
                        <td className="px-4 py-2 text-right font-medium">
                          {money(loan.outstanding)}
                        </td>
                        <td className="px-4 py-2">{formatDate(loan.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
    </>
  );
}

export const dynamic = 'force-dynamic';
