'use client';

import type { GetCurrentCashResult } from '@/actions/cash';
import type { CashMovementType, CashSession } from '@/libs/cash-helpers';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  addCashMovement,
  closeCashSession,
  openCashSession,
} from '@/actions/cash';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { DenominationCounter } from './DenominationCounter';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

const fmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value ?? 0;
  return fmt.format(Number.isFinite(n as number) ? (n as number) : 0);
}

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

function when(value: Date | string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return dateFmt.format(new Date(value));
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&[type=number]]:[-moz-appearance:textfield]';

const MANUAL_MOVEMENT_TYPES: { value: CashMovementType; label: string; income: boolean }[] = [
  { value: 'deposit', label: 'Depósito / ingreso', income: true },
  { value: 'expense', label: 'Gasto', income: false },
  { value: 'salary', label: 'Pago de nómina', income: false },
  { value: 'inventory_purchase', label: 'Compra de inventario', income: false },
  { value: 'withdrawal', label: 'Retiro', income: false },
];

const MOVEMENT_LABEL: Record<string, string> = {
  sale: 'Venta',
  deposit: 'Depósito',
  expense: 'Gasto',
  salary: 'Nómina',
  inventory_purchase: 'Compra inventario',
  withdrawal: 'Retiro',
};

function Card(props: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-5 shadow-xs', props.className)}>
      {props.children}
    </div>
  );
}

function Kpi(props: { label: string; value: string; tone?: 'default' | 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{props.label}</div>
      <div
        className={cn(
          `mt-2 font-display text-3xl font-medium tracking-tight tabular-nums`,
          props.tone === 'good' && 'text-success',
          props.tone === 'bad' && 'text-destructive',
        )}
      >
        {props.value}
      </div>
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

  // open form
  const [opening, setOpening] = useState('');
  const [openNotes, setOpenNotes] = useState('');

  // movement form
  const [movType, setMovType] = useState<CashMovementType>('expense');
  const [movAmount, setMovAmount] = useState('');
  const [movReason, setMovReason] = useState('');

  // close form
  const [counted, setCounted] = useState('');
  const [closeNotes, setCloseNotes] = useState('');

  const { session, movements, expected } = props.current;

  const countedNum = Number.parseFloat(counted);
  const previewDiff = useMemo(() => {
    if (!Number.isFinite(countedNum)) {
      return null;
    }
    return Number.parseFloat((countedNum - expected).toFixed(2));
  }, [countedNum, expected]);

  function run(fn: () => Promise<unknown>, reset?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        reset?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ocurrió un error');
      }
    });
  }

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

      {error && (
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
            <Card className="max-w-md">
              <div className="text-lg font-semibold">Caja cerrada</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Abre la caja con el monto base (efectivo inicial) para empezar a operar.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="opening">
                    Monto base
                  </label>
                  <input
                    id="opening"
                    className={inputCls}
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
                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="openNotes">
                    Notas (opcional)
                  </label>
                  <input
                    id="openNotes"
                    className={inputCls}
                    value={openNotes}
                    onChange={e => setOpenNotes(e.target.value)}
                  />
                </div>
                <Button
                  disabled={pending || opening === ''}
                  onClick={() =>
                    run(
                      () => openCashSession(opening, openNotes || null),
                      () => {
                        setOpening('');
                        setOpenNotes('');
                      },
                    )}
                >
                  Abrir caja
                </Button>
              </div>
            </Card>
          )
        : (
            <>
              <div className="
                grid gap-4
                sm:grid-cols-3
              "
              >
                <Kpi label="Monto base" value={money(session.openingAmount)} />
                <Kpi label="Esperado en caja" value={money(expected)} tone="good" />
                <Kpi label="Movimientos" value={String(movements.length)} />
              </div>

              <div className="text-sm text-muted-foreground">
                Abierta por
                {' '}
                <span className="font-medium text-foreground">{session.openedBy}</span>
                {' · '}
                {when(session.openedAt)}
              </div>

              <div className="
                grid gap-6
                lg:grid-cols-2
              "
              >
                {/* Movimiento */}
                <Card>
                  <div className="mb-3 text-sm font-semibold">Registrar movimiento</div>
                  <div className="space-y-3">
                    <select
                      className={inputCls}
                      value={movType}
                      onChange={e => setMovType(e.target.value as CashMovementType)}
                    >
                      {MANUAL_MOVEMENT_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                    <input
                      className={inputCls}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      placeholder="Monto"
                      value={movAmount}
                      onChange={e => setMovAmount(e.target.value)}
                    />
                    <input
                      className={inputCls}
                      placeholder="Motivo"
                      value={movReason}
                      onChange={e => setMovReason(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={pending || movAmount === '' || movReason.trim() === ''}
                      onClick={() =>
                        run(
                          () => addCashMovement(movType, movAmount, movReason),
                          () => {
                            setMovAmount('');
                            setMovReason('');
                          },
                        )}
                    >
                      Agregar movimiento
                    </Button>
                  </div>
                </Card>

                {/* Cierre / arqueo */}
                <Card>
                  <div className="mb-3 text-sm font-semibold">Cerrar caja (arqueo)</div>
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-sm font-medium" htmlFor="counted">
                        Efectivo contado
                      </label>
                      <input
                        id="counted"
                        className={inputCls}
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
                      <div className="text-sm">
                        Diferencia vs. esperado:
                        {' '}
                        <span
                          className={cn(
                            'font-semibold tabular-nums',
                            previewDiff === 0 && 'text-success',
                            previewDiff > 0 && 'text-success',
                            previewDiff < 0 && 'text-destructive',
                          )}
                        >
                          {money(previewDiff)}
                        </span>
                      </div>
                    )}
                    <input
                      className={inputCls}
                      placeholder="Notas de cierre (opcional)"
                      value={closeNotes}
                      onChange={e => setCloseNotes(e.target.value)}
                    />
                    <Button
                      variant="destructive"
                      disabled={pending || counted === ''}
                      onClick={() =>
                        run(
                          () => closeCashSession(counted, closeNotes || null),
                          () => {
                            setCounted('');
                            setCloseNotes('');
                          },
                        )}
                    >
                      Cerrar caja
                    </Button>
                  </div>
                </Card>
              </div>

              {/* Movimientos de la sesión */}
              <Card className="p-0">
                <div className="
                  border-b border-border px-5 py-3 text-sm font-semibold
                "
                >
                  Movimientos de la caja actual
                </div>
                {movements.length === 0
                  ? (
                      <div className="
                        px-5 py-8 text-center text-sm text-muted-foreground
                      "
                      >
                        Sin movimientos todavía.
                      </div>
                    )
                  : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="
                              border-b border-border text-left text-xs
                              text-muted-foreground
                            "
                            >
                              <th className="px-5 py-2 font-medium">Tipo</th>
                              <th className="px-5 py-2 font-medium">Motivo</th>
                              <th className="px-5 py-2 text-right font-medium">Monto</th>
                              <th className="px-5 py-2 font-medium">Cuándo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {movements.map(m => (
                              <tr
                                key={m.id}
                                className="
                                  border-b border-border
                                  last:border-0
                                "
                              >
                                <td className="px-5 py-2">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                                <td className="px-5 py-2 text-muted-foreground">{m.reason}</td>
                                <td className="
                                  px-5 py-2 text-right tabular-nums
                                "
                                >
                                  {money(m.amount)}
                                </td>
                                <td className="px-5 py-2 text-muted-foreground">{when(m.createdAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
              </Card>
            </>
          )}

      {/* Historial de cajas */}
      <Card className="p-0">
        <div className="border-b border-border px-5 py-3 text-sm font-semibold">
          Cierres recientes
        </div>
        {props.sessions.filter(s => s.status === 'closed').length === 0
          ? (
              <div className="
                px-5 py-8 text-center text-sm text-muted-foreground
              "
              >
                Aún no hay cierres registrados.
              </div>
            )
          : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="
                      border-b border-border text-left text-xs
                      text-muted-foreground
                    "
                    >
                      <th className="px-5 py-2 font-medium">Abierta</th>
                      <th className="px-5 py-2 font-medium">Cerrada</th>
                      <th className="px-5 py-2 text-right font-medium">Esperado</th>
                      <th className="px-5 py-2 text-right font-medium">Contado</th>
                      <th className="px-5 py-2 text-right font-medium">Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.sessions
                      .filter(s => s.status === 'closed')
                      .map((s) => {
                        const diff = Number.parseFloat(s.difference ?? '0') || 0;
                        return (
                          <tr
                            key={s.id}
                            className="
                              border-b border-border
                              last:border-0
                            "
                          >
                            <td className="px-5 py-2 text-muted-foreground">{when(s.openedAt)}</td>
                            <td className="px-5 py-2 text-muted-foreground">{when(s.closedAt)}</td>
                            <td className="px-5 py-2 text-right tabular-nums">{money(s.expectedAmount)}</td>
                            <td className="px-5 py-2 text-right tabular-nums">{money(s.countedAmount)}</td>
                            <td
                              className={cn(
                                `px-5 py-2 text-right font-medium tabular-nums`,
                                diff < 0 ? 'text-destructive' : 'text-success',
                              )}
                            >
                              {money(diff)}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
      </Card>
    </div>
  );
}
