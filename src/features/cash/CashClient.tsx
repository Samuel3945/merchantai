'use client';

import type { Direction } from './cash-ui';
import type { MovementSubmit } from './MovementModal';
import type {
  CashSecurityStatus,
  GetCurrentCashResult,
  OpenCaja,
  TodayCashKpis,
} from '@/actions/cash';
import type { ActionResult } from '@/libs/action-result';
import type { CashMovement, CashSession } from '@/libs/cash-helpers';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { addCashMovement, closeCashSession } from '@/actions/cash';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { ActivityFeed } from './ActivityFeed';
import { cashInputCls, money, relativeTime } from './cash-ui';
import { CashClosuresHistory } from './CashClosuresHistory';
import { CashHistory } from './CashHistory';
import { CashSecurityAlert } from './CashSecurityAlert';
import { DenominationCounter } from './DenominationCounter';
import { MovementModal } from './MovementModal';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

const dayFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

function whenDay(value: Date | string | null | undefined): string {
  return value ? dayFmt.format(new Date(value)) : '—';
}

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

function BreakdownRow(props: { label: string; value: string; sign?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="font-medium tabular-nums">
        {props.sign}
        {props.value}
      </span>
    </div>
  );
}

export function CashClient(props: {
  current: GetCurrentCashResult;
  sessions: CashSession[];
  alerts: FraudAlert[];
  kpis: TodayCashKpis;
  security: CashSecurityStatus;
  history: CashMovement[];
  openCajas: OpenCaja[];
  // 2C: optional treasury accounts for the container selector in MovementModal.
  treasuryAccounts?: TreasuryAccountRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [modal, setModal] = useState<Direction | null>(null);
  const [counted, setCounted] = useState('');
  const [closeNote, setCloseNote] = useState('');

  const { session, movements, breakdown, collections } = props.current;
  const expected = breakdown.expected;

  // Device tills (one per cashier). Shown read-only — each cashier does its own
  // arqueo from its POS; the dashboard caja below is the owner's own session.
  const deviceCajas = props.openCajas.filter(c => c.posTokenId);

  const countedNum = Number.parseFloat(counted);
  const previewDiff = useMemo(() => {
    if (!Number.isFinite(countedNum)) {
      return null;
    }
    return Number.parseFloat((countedNum - expected).toFixed(2));
  }, [countedNum, expected]);

  function run(fn: () => Promise<ActionResult<unknown>>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onSuccess?.();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  function openModal(direction: Direction) {
    setError(null);
    setModal(direction);
  }

  function submitMovement(p: MovementSubmit) {
    run(
      () =>
        addCashMovement(p.type, p.amount, p.reason, {
          category: p.category,
          supplierId: p.supplierId,
          // 2C: pass container ids for treasury dual-write (null when no selection).
          toAccountId: p.toAccountId,
          fromAccountId: p.fromAccountId,
        }),
      () => setModal(null),
    );
  }

  const closedSessions = props.sessions.filter(s => s.status === 'closed');
  const lastClose = closedSessions[0] ?? null;
  const lastCloseDiff = lastClose
    ? Number.parseFloat(lastClose.difference ?? '0') || 0
    : 0;

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

      <CashSecurityAlert
        security={props.security}
        onWithdraw={() => openModal('out')}
      />

      {error && !modal && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {/* Resumen financiero del día — derivado del ledger, siempre visible */}
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

      {deviceCajas.length > 0 && (
        <div className="space-y-3">
          <div>
            <div className="text-lg font-semibold">Cajas de los cajeros</div>
            <p className="text-sm text-muted-foreground">
              Cada caja opera por separado. Esto es solo lectura: el arqueo y el
              cierre los hace cada cajero en su propio POS.
            </p>
          </div>
          <div className="
            grid gap-3
            sm:grid-cols-2
            lg:grid-cols-3
          "
          >
            {deviceCajas.map(c => (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">
                      {c.deviceName || c.openedBy}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Abierta
                      {' '}
                      {relativeTime(c.openedAt)}
                    </div>
                  </div>
                  <span className="
                    shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs
                    font-medium text-emerald-600
                  "
                  >
                    Abierta
                  </span>
                </div>
                <div className="mt-3 flex items-end justify-between gap-2">
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Efectivo esperado
                    </div>
                    <div className="text-lg font-bold tabular-nums">
                      {money(c.expected)}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {c.movementCount}
                    {' '}
                    mov.
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {!session
        ? (
            <div className="
              grid items-start gap-6
              lg:grid-cols-2
            "
            >
              <Card className="p-5">
                <div className="text-lg font-semibold">Caja sin abrir</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  La caja se abre sola cuando registrás un movimiento o entra una
                  venta. No arrastra el dinero del día anterior.
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    size="lg"
                    className="flex-1"
                    disabled={pending}
                    onClick={() => openModal('in')}
                  >
                    + Entrada
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="flex-1"
                    disabled={pending}
                    onClick={() => openModal('out')}
                  >
                    − Salida
                  </Button>
                </div>
              </Card>

              {/* Último cierre — contexto de referencia para no abrir a ciegas */}
              <Card className="flex h-full flex-col p-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-muted-foreground">
                    Último cierre
                  </div>
                  {lastClose && (
                    <span className="text-xs text-muted-foreground">
                      {whenDay(lastClose.closedAt)}
                    </span>
                  )}
                </div>

                {lastClose
                  ? (
                      <div className="mt-4 flex flex-1 flex-col gap-4">
                        <div>
                          <div className="
                            font-display text-3xl font-semibold tracking-tight
                            tabular-nums
                          "
                          >
                            {money(lastClose.countedAmount)}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            Efectivo contado al cierre
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="
                            rounded-lg border border-border bg-background p-3
                          "
                          >
                            <div className="text-xs text-muted-foreground">
                              Diferencia
                            </div>
                            <div
                              className={cn(
                                'mt-1 font-medium tabular-nums',
                                lastCloseDiff === 0 && 'text-success',
                                lastCloseDiff > 0 && 'text-success',
                                lastCloseDiff < 0 && 'text-destructive',
                              )}
                            >
                              {lastCloseDiff > 0 ? '+' : ''}
                              {money(lastCloseDiff)}
                            </div>
                          </div>
                          <div className="
                            rounded-lg border border-border bg-background p-3
                          "
                          >
                            <div className="text-xs text-muted-foreground">
                              Responsable
                            </div>
                            <div className="mt-1 truncate font-medium">
                              {lastClose.closedBy ?? '—'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  : (
                      <div className="
                        mt-4 flex flex-1 flex-col items-center justify-center
                        rounded-lg border border-dashed border-border py-8
                        text-center text-sm text-muted-foreground
                      "
                      >
                        Aún no registraste cierres. Cuando cierres tu primera
                        caja, vas a ver acá el resumen.
                      </div>
                    )}
              </Card>
            </div>
          )
        : (
            <>
              {/* Hero — la única pregunta que importa */}
              <Card className="p-6">
                <div className="
                  flex flex-col gap-6
                  lg:flex-row lg:items-center lg:justify-between
                "
                >
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">
                      Efectivo esperado en caja
                    </div>
                    <div className="
                      mt-1 font-display text-4xl font-semibold tracking-tight
                      tabular-nums
                      sm:text-5xl
                    "
                    >
                      {money(expected)}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Abierta por
                      {' '}
                      <span className="font-medium text-foreground">
                        {session.openedBy}
                      </span>
                      {' · '}
                      {relativeTime(session.openedAt)}
                    </div>
                  </div>

                  <div className="
                    w-full max-w-xs space-y-2 rounded-lg border border-border
                    bg-background p-4
                  "
                  >
                    <BreakdownRow label="Base inicial" value={money(breakdown.opening)} />
                    <BreakdownRow label="Ventas efectivo" value={money(breakdown.cashSales)} sign="+" />
                    <BreakdownRow label="Entradas" value={money(breakdown.entradas)} sign="+" />
                    <BreakdownRow label="Salidas" value={money(breakdown.salidas)} sign="−" />
                  </div>
                </div>
              </Card>

              {/* Acciones rápidas */}
              <div className="
                grid grid-cols-1 gap-3
                sm:grid-cols-2
              "
              >
                <Button
                  size="lg"
                  className="h-14 text-base"
                  disabled={pending}
                  onClick={() => openModal('in')}
                >
                  + Entrada
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-14 text-base"
                  disabled={pending}
                  onClick={() => openModal('out')}
                >
                  − Salida
                </Button>
              </div>

              {/* Tarjetas secundarias */}
              <div className="
                grid grid-cols-2 gap-3
                lg:grid-cols-4
              "
              >
                <StatCard label="Ventas efectivo" value={money(breakdown.cashSales)} tone="in" />
                <StatCard label="Entradas" value={money(breakdown.entradas)} tone="in" />
                <StatCard label="Salidas" value={money(breakdown.salidas)} tone="out" />
                <StatCard label="Movimientos" value={String(breakdown.movementCount)} />
              </div>

              {/* Cobros por método: efectivo (en cajón) vs digital (no entra al
                  cajón). Incluye ventas y abonos de fiado de esta sesión. */}
              <div className="space-y-2">
                <div className="text-sm font-medium">
                  Cobros por método
                  <span className="
                    ml-1 text-xs font-normal text-muted-foreground
                  "
                  >
                    · esta sesión · ventas + abonos
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

              <div className="
                grid gap-6
                lg:grid-cols-5
              "
              >
                {/* Actividad */}
                <Card className="
                  p-0
                  lg:col-span-3
                "
                >
                  <div className="
                    border-b border-border px-5 py-3 text-sm font-semibold
                  "
                  >
                    Actividad reciente
                  </div>
                  <ActivityFeed movements={movements} />
                </Card>

                {/* Cierre */}
                <Card className="
                  border-primary/30 bg-primary/5 p-5
                  lg:col-span-2
                "
                >
                  <div className="text-sm font-semibold">Cerrar caja</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Contá el efectivo físico y compará con lo esperado.
                  </p>

                  <div className="mt-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Esperado</span>
                      <span className="
                        font-display text-lg font-medium tabular-nums
                      "
                      >
                        {money(expected)}
                      </span>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium" htmlFor="counted">
                        Efectivo contado
                      </label>
                      <input
                        id="counted"
                        className={cashInputCls}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        placeholder="0"
                        value={counted}
                        onChange={e => setCounted(e.target.value)}
                      />
                      <DenominationCounter
                        className="mt-2"
                        onTotal={t => setCounted(t > 0 ? String(t) : '')}
                      />
                    </div>

                    {previewDiff !== null && (
                      <div className="
                        flex items-center justify-between rounded-lg border
                        border-border bg-background px-3 py-2
                      "
                      >
                        <span className="text-sm text-muted-foreground">Diferencia</span>
                        <span
                          className={cn(
                            'font-display text-lg font-semibold tabular-nums',
                            previewDiff === 0 && 'text-success',
                            previewDiff > 0 && 'text-success',
                            previewDiff < 0 && 'text-destructive',
                          )}
                        >
                          {previewDiff > 0 ? '+' : ''}
                          {money(previewDiff)}
                        </span>
                      </div>
                    )}

                    {previewDiff !== null && previewDiff !== 0 && (
                      <input
                        className={cashInputCls}
                        placeholder="Nota: explica la diferencia (opcional)"
                        value={closeNote}
                        onChange={e => setCloseNote(e.target.value)}
                      />
                    )}

                    <Button
                      size="lg"
                      variant="destructive"
                      className="w-full"
                      disabled={pending || counted === ''}
                      onClick={() =>
                        run(
                          () => closeCashSession(counted, closeNote || null),
                          () => {
                            setCounted('');
                            setCloseNote('');
                          },
                        )}
                    >
                      Cerrar caja
                    </Button>
                  </div>
                </Card>
              </div>
            </>
          )}

      {/* Historial de cierres — arqueos permanentes con filtros */}
      <CashClosuresHistory sessions={props.sessions} />

      {/* Historial completo — ledger permanente con filtros */}
      <CashHistory movements={props.history} />

      {modal && (
        <MovementModal
          direction={modal}
          pending={pending}
          error={error}
          onClose={() => setModal(null)}
          onSubmit={submitMovement}
          treasuryAccounts={props.treasuryAccounts}
        />
      )}
    </div>
  );
}
