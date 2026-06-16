'use client';

import type {
  CashSecurityStatus,
  GetCurrentCashResult,
  OpenCaja,
  TodayCashKpis,
} from '@/actions/cash';
import type { CashMovement, CashSession } from '@/libs/cash-helpers';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { cn } from '@/utils/Helpers';
import { money } from './cash-ui';
import { CashClosuresHistory } from './CashClosuresHistory';
import { CashHistory } from './CashHistory';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

function Card(props: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card shadow-xs',
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

function StatCard(props: {
  label: string;
  value: string;
  tone?: 'in' | 'out';
}) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted-foreground">
        {props.label}
      </div>
      <div
        className={cn(
          'mt-1.5 font-display text-xl font-medium tracking-tight tabular-nums',
          props.tone === 'in' && 'text-success',
        )}
      >
        {props.value}
      </div>
    </Card>
  );
}

// Caja (admin) — SUPERVISION + VERIFICATION ONLY. The owner does NOT operate a
// till here: there is no own-session hero, no entrada/salida, no cierre. Each
// cashier opens/closes/moves cash on its own POS; the supervision of those cajas
// lives in CajasSupervision (top of the page). This screen answers "what
// happened across the business today" — KPIs, collections by method, and the
// permanent arqueo + movement history for audit.
export function CashClient(props: {
  current: GetCurrentCashResult;
  sessions: CashSession[];
  alerts: FraudAlert[];
  kpis: TodayCashKpis;
  security: CashSecurityStatus;
  history: CashMovement[];
  openCajas: OpenCaja[];
  treasuryAccounts?: TreasuryAccountRow[];
}) {
  const { collections } = props.current;

  return (
    <div className="space-y-6">
      {props.alerts.length > 0 && (
        <div className="space-y-2">
          {props.alerts.map(a => (
            <div
              key={a.kind}
              className={cn(
                'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
                a.severity === 'high'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-warn/30 bg-warn/10 text-warn',
              )}
            >
              <span className="mt-0.5 size-2 shrink-0 rounded-full bg-current" />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Resumen financiero del día — derivado del ledger, solo lectura */}
      <div>
        <div className="mb-2 text-sm font-semibold text-muted-foreground">
          Resumen del día
        </div>
        <div className="
          grid grid-cols-2 gap-3
          lg:grid-cols-4
        "
        >
          <StatCard label="Gastos hoy" value={money(props.kpis.gastosHoy)} />
          <StatCard label="Retiros hoy" value={money(props.kpis.retirosHoy)} />
          <StatCard
            label="Pagos a proveedores"
            value={money(props.kpis.pagosProveedores)}
          />
          <StatCard
            label="Gastos operativos"
            value={money(props.kpis.gastosOperativos)}
          />
        </div>
      </div>

      {/* Cobros por método — cómo entró la plata hoy (ventas + abonos). */}
      <div className="space-y-2">
        <div className="text-sm font-medium">
          Cobros por método
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            · ventas + abonos
          </span>
        </div>
        <div className="
          grid grid-cols-2 gap-3
          sm:grid-cols-3
          lg:grid-cols-6
        "
        >
          <StatCard label="Efectivo" value={money(collections.efectivo)} tone="in" />
          <StatCard label="Transferencia" value={money(collections.transferencia)} />
          <StatCard label="Nequi" value={money(collections.nequi)} />
          <StatCard label="Daviplata" value={money(collections.daviplata)} />
          <StatCard label="Otros" value={money(collections.otros)} />
          <StatCard label="Total general" value={money(collections.total)} tone="in" />
        </div>
      </div>

      {/* Historial de cierres — arqueos permanentes con filtros */}
      <CashClosuresHistory sessions={props.sessions} />

      {/* Historial completo — ledger permanente con filtros */}
      <CashHistory movements={props.history} />
    </div>
  );
}
