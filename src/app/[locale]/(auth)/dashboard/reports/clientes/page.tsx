'use client';

import type { CustomerInsights } from '@/actions/analytics';
import { useEffect, useRef, useState } from 'react';
import { getCustomerInsights } from '@/actions/analytics';
import { fmtMoney } from '@/features/reports/format';
import {
  ChartCard,
  RankBars,
  StatTile,
} from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';

const EMPTY: CustomerInsights = {
  totalCustomers: 0,
  newInRange: 0,
  active30d: 0,
  inactive: 0,
  topCustomers: [],
};

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

function formatDate(iso: string | null): string {
  if (!iso) {
    return 'Nunca';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export default function ClientesPage() {
  const [data, setData] = useState<CustomerInsights>(EMPTY);

  return (
    <ReportShell title="Clientes">
      {({ start, end }) => (
        <Loader start={start} end={end} onData={setData}>
          <p className="text-sm text-muted-foreground">
            Conseguir un cliente nuevo cuesta más que mantener uno. Vigilá los
            inactivos (hace +30 días que no compran): un mensaje a tiempo los
            recupera antes de que se vayan a la competencia.
          </p>

          <div className="
            grid grid-cols-2 gap-3
            sm:grid-cols-4
          "
          >
            <StatTile label="Clientes" value={String(data.totalCustomers)} />
            <StatTile label="Nuevos (período)" value={String(data.newInRange)} tone="good" />
            <StatTile label="Activos (30d)" value={String(data.active30d)} tone="good" />
            <StatTile
              label="Inactivos"
              value={String(data.inactive)}
              tone={data.inactive > 0 ? 'warn' : 'default'}
            />
          </div>

          <ChartCard
            title="Mejores clientes por gasto total"
            description="Tus clientes más valiosos. Cuidalos: son los que sostienen la caja."
          >
            <RankBars
              data={data.topCustomers.slice(0, 10).map(c => ({
                name: c.name,
                totalSpent: c.totalSpent,
              }))}
              labelKey="name"
              valueKey="totalSpent"
              name="Gasto total"
            />
          </ChartCard>

          <div className="rounded-lg border bg-background shadow-xs">
            <div className="border-b px-4 py-3 text-sm font-semibold">
              Top 20 clientes
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2">Cliente</th>
                    <th className="px-3 py-2 text-right">Gasto total</th>
                    <th className="px-3 py-2 text-right">Última compra</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCustomers.length === 0
                    ? (
                        <tr>
                          <td
                            colSpan={3}
                            className="
                              px-3 py-8 text-center text-muted-foreground
                            "
                          >
                            Sin clientes registrados
                          </td>
                        </tr>
                      )
                    : (
                        data.topCustomers.map(c => (
                          <tr
                            key={`${c.name}-${c.lastPurchaseAt ?? 'na'}`}
                            className="border-t"
                          >
                            <td className="px-3 py-2">{c.name}</td>
                            <td className="px-3 py-2 text-right font-medium">
                              {fmtMoney(c.totalSpent)}
                            </td>
                            <td className="
                              px-3 py-2 text-right text-muted-foreground
                            "
                            >
                              {formatDate(c.lastPurchaseAt)}
                            </td>
                          </tr>
                        ))
                      )}
                </tbody>
              </table>
            </div>
          </div>
        </Loader>
      )}
    </ReportShell>
  );
}

function Loader({
  start,
  end,
  onData,
  children,
}: {
  start: string;
  end: string;
  onData: (data: CustomerInsights) => void;
  children: React.ReactNode;
}) {
  const prev = useRef('');
  useEffect(() => {
    const key = `${start}|${end}`;
    if (key !== prev.current) {
      prev.current = key;
      getCustomerInsights(start, end).then(onData).catch(() => onData(EMPTY));
    }
  }, [start, end, onData]);
  return <div className="space-y-4">{children}</div>;
}
