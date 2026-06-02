'use client';

import type { ExpirationReport } from '@/actions/analytics';
import { useEffect, useState } from 'react';
import { getExpirationRisk } from '@/actions/analytics';
import { fmtMoney } from '@/features/reports/format';
import {
  ChartCard,
  ColumnBars,
  DonutChart,
  StatTile,
} from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';

const EMPTY: ExpirationReport = {
  totalAtRisk: 0,
  byTier: [],
  suggestions: [],
};

const TIER_LABELS: Record<string, string> = {
  atencion: 'Atención',
  urgente: 'Urgente',
  critico: 'Crítico',
};

const TIER_COLORS: Record<string, string> = {
  atencion: '#B45309',
  urgente: '#C2410C',
  critico: '#B91C1C',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendientes',
  accepted: 'Aceptadas',
  rejected: 'Rechazadas',
  superseded: 'Reemplazadas',
  expired: 'Expiradas',
};

export default function VencimientosPage() {
  const [data, setData] = useState<ExpirationReport>(EMPTY);

  useEffect(() => {
    getExpirationRisk().then(setData).catch(() => setData(EMPTY));
  }, []);

  const accepted = data.suggestions.find(s => s.status === 'accepted')?.count ?? 0;
  const rejected = data.suggestions.find(s => s.status === 'rejected')?.count ?? 0;
  const decided = accepted + rejected;

  return (
    <ReportShell title="Vencimientos (Smart Stock)" showDateRange={false}>
      {() => (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Mercadería perecedera en riesgo de vencerse. La IA sugiere descuentos
            para venderla antes de tener que tirarla: cada peso acá es plata que
            podés salvar si actuás a tiempo.
          </p>

          <div className="
            grid grid-cols-1 gap-3
            sm:grid-cols-3
          "
          >
            <StatTile
              label="Valor en riesgo"
              value={fmtMoney(data.totalAtRisk)}
              tone={data.totalAtRisk > 0 ? 'warn' : 'good'}
            />
            <StatTile
              label="Productos en riesgo"
              value={String(data.byTier.reduce((a, t) => a + t.count, 0))}
            />
            <StatTile
              label="Sugerencias aplicadas"
              value={decided > 0 ? `${Math.round((accepted / decided) * 100)}%` : '—'}
              hint={`${accepted} aceptadas · ${rejected} rechazadas`}
              tone="good"
            />
          </div>

          <ChartCard
            title="Valor en riesgo por nivel"
            description="Atención → Urgente → Crítico. Atacá primero lo crítico."
          >
            <ColumnBars
              data={data.byTier.map(t => ({
                label: TIER_LABELS[t.tier] ?? t.tier,
                value: t.value,
                fill: TIER_COLORS[t.tier],
              }))}
              labelKey="label"
              valueKey="value"
              name="Valor en riesgo"
              color="#C2410C"
            />
          </ChartCard>

          <ChartCard
            title="Respuesta a las sugerencias de la IA"
            description="Cuántas sugerencias de descuento aceptás vs rechazás."
          >
            <DonutChart
              data={data.suggestions.map(s => ({
                label: STATUS_LABELS[s.status] ?? s.status,
                count: s.count,
              }))}
              nameKey="label"
              valueKey="count"
              money={false}
            />
          </ChartCard>
        </div>
      )}
    </ReportShell>
  );
}
