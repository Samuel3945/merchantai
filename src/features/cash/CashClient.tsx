'use client';

import type { Direction } from './cash-ui';
import type { MovementSubmit } from './MovementModal';
import type { GetCurrentCashResult } from '@/actions/cash';
import type { ActionResult } from '@/libs/action-result';
import type { CashSession } from '@/libs/cash-helpers';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  addCashMovement,
  closeCashSession,
  openCashSession,
} from '@/actions/cash';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { ActivityFeed } from './ActivityFeed';
import { cashInputCls, money, relativeTime } from './cash-ui';
import { DenominationCounter } from './DenominationCounter';
import { MovementModal } from './MovementModal';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

function when(value: Date | string | null | undefined): string {
  return value ? dateFmt.format(new Date(value)) : '—';
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
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [opening, setOpening] = useState('');
  const [modal, setModal] = useState<Direction | null>(null);
  const [counted, setCounted] = useState('');
  const [closeNote, setCloseNote] = useState('');

  const { session, movements, breakdown } = props.current;
  const expected = breakdown.expected;

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
        }),
      () => setModal(null),
    );
  }

  const closedSessions = props.sessions.filter(s => s.status === 'closed');

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

      {error && !modal && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {!session
        ? (
            <Card className="max-w-md p-5">
              <div className="text-lg font-semibold">Abrir caja</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Ingresá el efectivo con el que arrancás la jornada. No se arrastra
                el dinero del día anterior: vos decidís cuánto dejás disponible.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium" htmlFor="opening">
                    Base inicial
                  </label>
                  <input
                    id="opening"
                    className={cashInputCls}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    placeholder="0"
                    value={opening}
                    onChange={e => setOpening(e.target.value)}
                  />
                  <DenominationCounter
                    className="mt-2"
                    onTotal={t => setOpening(t > 0 ? String(t) : '')}
                  />
                </div>
                <Button
                  size="lg"
                  className="w-full"
                  disabled={pending || opening === ''}
                  onClick={() =>
                    run(
                      () => openCashSession(opening, null),
                      () => setOpening(''),
                    )}
                >
                  Abrir caja
                </Button>
              </div>
            </Card>
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

      {/* Cierres recientes */}
      <Card className="p-0">
        <div className="border-b border-border px-5 py-3 text-sm font-semibold">
          Cierres recientes
        </div>
        {closedSessions.length === 0
          ? (
              <div className="
                px-5 py-8 text-center text-sm text-muted-foreground
              "
              >
                Aún no hay cierres registrados.
              </div>
            )
          : (
              <ul className="divide-y divide-border">
                {closedSessions.map((s) => {
                  const diff = Number.parseFloat(s.difference ?? '0') || 0;
                  return (
                    <li
                      key={s.id}
                      className="
                        flex items-center justify-between gap-3 px-5 py-3
                      "
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{when(s.closedAt)}</div>
                        <div className="text-xs text-muted-foreground">
                          Contado
                          {' '}
                          {money(s.countedAmount)}
                          {' · esperado '}
                          {money(s.expectedAmount)}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-sm font-semibold tabular-nums',
                          diff < 0 ? 'text-destructive' : 'text-success',
                        )}
                      >
                        {diff > 0 ? '+' : ''}
                        {money(diff)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
      </Card>

      {modal && (
        <MovementModal
          direction={modal}
          pending={pending}
          error={error}
          onClose={() => setModal(null)}
          onSubmit={submitMovement}
        />
      )}
    </div>
  );
}
