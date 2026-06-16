'use client';

import type { ActionResult } from '@/libs/action-result';
import type {
  ReconciliationStatus,
  TransferReconciliation,
} from '@/libs/transfer-reconciliation';
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Clock,
  Pencil,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  confirmAllPendingTransfers,
  confirmTransfer,
  correctConfirmedTransfer,
  markTransferMismatch,
  markTransferNotArrived,
  reclassifySalePayment,
  recordTransferExplanation,
  resolveTransfer,
} from '@/actions/transfer-reconciliation';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { cashInputCls, money, stamp } from './cash-ui';

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

// ── State presentation ───────────────────────────────────────────────────────

const STATE_META: Record<
  ReconciliationStatus,
  { label: string; badge: string; dot: string }
> = {
  pending: {
    label: 'Por verificar',
    badge: 'bg-warn/10 text-warn',
    dot: 'bg-warn',
  },
  confirmed: {
    label: 'Cuadra',
    badge: 'bg-success/10 text-success',
    dot: 'bg-success',
  },
  mismatch: {
    label: 'Llegó otro monto',
    badge: 'bg-warn/10 text-warn',
    dot: 'bg-warn',
  },
  not_arrived: {
    label: 'No llegó',
    badge: 'bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
};

function StateBadge({ status }: { status: ReconciliationStatus }) {
  const m = STATE_META[status];
  return (
    <span
      className={cn(
        `
          inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs
          font-semibold
        `,
        m.badge,
      )}
    >
      {m.label}
    </span>
  );
}

function StatCard(props: {
  count: number;
  label: string;
  sub: string;
  tone: 'success' | 'warn' | 'destructive';
}) {
  const dot = {
    success: 'bg-success',
    warn: 'bg-warn',
    destructive: 'bg-destructive',
  }[props.tone];
  const ink = {
    success: 'text-success',
    warn: 'text-warn',
    destructive: 'text-destructive',
  }[props.tone];
  return (
    <Card className="flex items-center gap-4 p-4">
      <span className={cn('size-3.5 shrink-0 rounded-full', dot)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{props.label}</div>
        <div className="text-xs text-muted-foreground">{props.sub}</div>
      </div>
      <div className={cn('font-display text-3xl font-semibold tabular-nums', ink)}>
        {props.count}
      </div>
    </Card>
  );
}

// Row reference line: "10 jun 2026, 14:02 · Ref. M5K8-2210".
function RowMeta({ row }: { row: TransferReconciliation }) {
  return (
    <div className="
      mt-0.5 flex items-center gap-2 text-xs text-muted-foreground
    "
    >
      <span>{stamp(row.createdAt)}</span>
      {row.reference && (
        <>
          <span className="text-input">·</span>
          <span className="tabular-nums">
            Ref.
            {' '}
            {row.reference}
          </span>
        </>
      )}
    </div>
  );
}

// ── Filtering ────────────────────────────────────────────────────────────────

type Chip = 'all' | 'pending' | 'confirmed';

function rowMatchesChip(row: TransferReconciliation, chip: Chip): boolean {
  if (chip === 'all') {
    return true;
  }
  if (chip === 'pending') {
    return row.status === 'pending';
  }
  return row.status === 'confirmed' || row.status === 'mismatch';
}

function rowMatchesQuery(row: TransferReconciliation, q: string): boolean {
  if (!q) {
    return true;
  }
  if (row.reference && row.reference.toLowerCase().includes(q)) {
    return true;
  }
  const digits = q.replace(/\D/g, '');
  if (digits === '') {
    return false;
  }
  const amounts = [row.expectedAmount, row.arrivedAmount ?? '']
    .map(a => a.replace(/\D/g, ''))
    .filter(Boolean);
  return amounts.some(a => a.includes(digits));
}

export function TransferReconciliationPanel(props: {
  reconciliations: TransferReconciliation[]; // pending
  investigating: TransferReconciliation[]; // not_arrived
  history: TransferReconciliation[]; // confirmed + mismatch
  pendingCount: number;
  pendingTotal: number;
  counts: { pending: number; confirmedToday: number; notArrived: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pending-row inline editors.
  const [mismatchId, setMismatchId] = useState<string | null>(null);
  const [mismatchAmount, setMismatchAmount] = useState('');

  // Confirmed-history inline editor (the "edit a confirmed transfer" feature).
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');

  // Investigation inline editors.
  const [explainId, setExplainId] = useState<string | null>(null);
  const [explainText, setExplainText] = useState('');
  const [reclassifyId, setReclassifyId] = useState<string | null>(null);
  const [reclassifyMethod, setReclassifyMethod] = useState('Efectivo');
  const [reclassifyAmount, setReclassifyAmount] = useState('');

  // Filters / sort (display only — never mutate, just locate).
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sortDesc, setSortDesc] = useState(true);

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

  const allRows = useMemo(
    () => [...props.reconciliations, ...props.history],
    [props.reconciliations, props.history],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows
      .filter(r => rowMatchesChip(r, chip) && rowMatchesQuery(r, q))
      .sort((a, b) => {
        const diff
          = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return sortDesc ? -diff : diff;
      });
  }, [allRows, query, chip, sortDesc]);

  const chips: { k: Chip; label: string }[] = [
    { k: 'all', label: `Todas · ${allRows.length}` },
    {
      k: 'confirmed',
      label: `Confirmadas · ${props.history.length}`,
    },
    {
      k: 'pending',
      label: `Por verificar · ${props.reconciliations.length}`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-3
      "
      >
        <StatCard
          count={props.counts.confirmedToday}
          label="Cuadran"
          sub="ya verificadas hoy"
          tone="success"
        />
        <StatCard
          count={props.counts.pending}
          label="Por verificar"
          sub="el cajero las revisa"
          tone="warn"
        />
        <StatCard
          count={props.counts.notArrived}
          label="No llegó"
          sub="hay que averiguar"
          tone="destructive"
        />
      </div>

      <Card className="border-primary/30 bg-primary/5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">
              Conciliación de transferencias
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Compará contra tu cuenta (Nequi, banco). Confirmá todo y marcá solo
              las que no cuadran.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Monto pendiente</div>
            <div className="font-display text-xl font-medium tabular-nums">
              {money(props.pendingTotal)}
            </div>
          </div>
        </div>

        {props.pendingCount > 0 && (
          <Button
            size="lg"
            className="mt-4 w-full"
            disabled={pending}
            onClick={() => run(() => confirmAllPendingTransfers())}
          >
            Confirmar todo (
            {props.pendingCount}
            )
          </Button>
        )}
      </Card>

      {error && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {/* ¿Las transferencias cuadran? — search + chips + sort + the list */}
      <Card className="overflow-hidden p-0">
        <div className="
          flex flex-wrap items-center gap-3 border-b border-border p-4
        "
        >
          <div className={cn(cashInputCls, `
            flex min-w-56 flex-1 items-center gap-2
          `)}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por referencia de pago o monto…"
              className="
                w-full bg-transparent text-sm outline-none
                placeholder:text-muted-foreground
              "
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="
                  shrink-0 text-muted-foreground
                  hover:text-foreground
                "
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {chips.map(c => (
              <button
                key={c.k}
                type="button"
                onClick={() => setChip(c.k)}
                className={cn(
                  `
                    h-9 rounded-full border px-3.5 text-xs font-semibold
                    transition-colors
                  `,
                  chip === c.k
                    ? 'border-primary bg-primary text-primary-foreground'
                    : `
                      border-border bg-secondary text-secondary-foreground
                      hover:bg-accent
                    `,
                )}
              >
                {c.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSortDesc(s => !s)}
              className="
                inline-flex h-9 items-center gap-1.5 rounded-full border
                border-border bg-secondary px-3.5 text-xs font-semibold
                text-secondary-foreground transition-colors
                hover:bg-accent
              "
              title="Ordenar por fecha"
            >
              {sortDesc
                ? <ArrowDownWideNarrow className="size-4" />
                : <ArrowUpWideNarrow className="size-4" />}
              {sortDesc ? 'Más recientes' : 'Más antiguas'}
            </button>
          </div>
        </div>

        {shown.length === 0
          ? (
              <div className="p-10 text-center">
                <div className="text-sm font-semibold">
                  No encontramos ninguna transferencia
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Probá con otra referencia, otro monto o quitá los filtros.
                </p>
              </div>
            )
          : (
              <ul className="divide-y divide-border">
                {shown.map((r) => {
                  const isPending = r.status === 'pending';
                  const isConfirmed
                    = r.status === 'confirmed' || r.status === 'mismatch';
                  const shownAmount
                    = r.arrivedAmount ?? r.expectedAmount;
                  return (
                    <li key={r.id} className="p-4">
                      <div className="
                        flex flex-wrap items-center justify-between gap-3
                      "
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="
                            flex size-9 shrink-0 items-center justify-center
                            rounded-lg bg-secondary text-muted-foreground
                          "
                          >
                            <Send className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="
                              flex items-center gap-2 text-sm font-medium
                            "
                            >
                              <span>{r.method}</span>
                              <span className="font-display tabular-nums">
                                {money(shownAmount)}
                              </span>
                            </div>
                            <RowMeta row={r} />
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <StateBadge status={r.status} />
                          {isPending && (
                            <>
                              <Button
                                size="sm"
                                disabled={pending}
                                onClick={() => run(() => confirmTransfer(r.id))}
                              >
                                Confirmar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={pending}
                                onClick={() => {
                                  setMismatchId(mismatchId === r.id ? null : r.id);
                                  setMismatchAmount('');
                                }}
                              >
                                Otro monto
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={pending}
                                onClick={() =>
                                  run(() => markTransferNotArrived(r.id))}
                              >
                                No llegó
                              </Button>
                            </>
                          )}
                          {isConfirmed && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => {
                                setEditId(editId === r.id ? null : r.id);
                                setEditAmount(
                                  r.arrivedAmount ?? r.expectedAmount,
                                );
                              }}
                            >
                              <Pencil className="size-3.5" />
                              Editar
                            </Button>
                          )}
                        </div>
                      </div>

                      {isPending && mismatchId === r.id && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            className={cn(cashInputCls, 'max-w-40')}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            placeholder="Monto que llegó"
                            value={mismatchAmount}
                            onChange={e => setMismatchAmount(e.target.value)}
                          />
                          <Button
                            size="sm"
                            disabled={pending || mismatchAmount === ''}
                            onClick={() =>
                              run(
                                () => markTransferMismatch(r.id, mismatchAmount),
                                () => {
                                  setMismatchId(null);
                                  setMismatchAmount('');
                                },
                              )}
                          >
                            Guardar diferencia
                          </Button>
                        </div>
                      )}

                      {isConfirmed && editId === r.id && (
                        <div className="
                          mt-3 space-y-2 rounded-lg border border-border
                          bg-background p-3
                        "
                        >
                          <div className="text-xs text-muted-foreground">
                            Corregí el monto que realmente llegó. Tesorería se
                            ajusta sola con la diferencia.
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              className={cn(cashInputCls, 'max-w-40')}
                              type="number"
                              inputMode="decimal"
                              min="0"
                              value={editAmount}
                              onChange={e => setEditAmount(e.target.value)}
                            />
                            <Button
                              size="sm"
                              disabled={pending || editAmount === ''}
                              onClick={() =>
                                run(
                                  () =>
                                    correctConfirmedTransfer(r.id, {
                                      kind: 'amount',
                                      arrivedAmount: editAmount,
                                    }),
                                  () => setEditId(null),
                                )}
                            >
                              Guardar corrección
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={pending}
                              onClick={() =>
                                run(
                                  () =>
                                    correctConfirmedTransfer(r.id, {
                                      kind: 'not_arrived',
                                    }),
                                  () => setEditId(null),
                                )}
                            >
                              En realidad no llegó
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => setEditId(null)}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
      </Card>

      {props.investigating.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="font-display text-lg font-semibold">
              En investigación
            </h3>
            <p className="text-sm text-muted-foreground">
              No aparecieron en la cuenta. El cajero tiene que explicar qué pasó
              con cada una.
            </p>
          </div>
          <div className="
            space-y-2 rounded-xl border border-destructive/40 p-2 ring-4
            ring-destructive/5
          "
          >
            {props.investigating.map(r => (
              <Card key={r.id} className="border-destructive/20 p-4">
                <div className="
                  flex flex-wrap items-center justify-between gap-3
                "
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="
                      flex size-9 shrink-0 items-center justify-center
                      rounded-lg bg-destructive/10 text-destructive
                    "
                    >
                      <AlertTriangle className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="
                        flex flex-wrap items-center gap-2 text-sm font-medium
                      "
                      >
                        <span>{r.method}</span>
                        <span className="font-display tabular-nums">
                          {money(r.expectedAmount)}
                        </span>
                        <span className="
                          inline-flex h-6 items-center rounded-full
                          bg-destructive/10 px-2.5 text-xs font-semibold
                          text-destructive
                        "
                        >
                          El cajero debe explicar
                        </span>
                      </div>
                      <RowMeta row={r} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        run(() => resolveTransfer(r.id, 'receivable'))}
                    >
                      Cobrar (fiado)
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        run(() => resolveTransfer(r.id, 'cashier_liability'))}
                    >
                      Culpa del cajero
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => run(() => resolveTransfer(r.id, 'loss'))}
                    >
                      Pérdida
                    </Button>
                  </div>
                </div>

                {r.cashierExplanation && (
                  <div className="
                    mt-3 rounded-lg border border-border bg-background px-3 py-2
                    text-xs
                  "
                  >
                    <span className="text-muted-foreground">
                      Explicación del cajero:
                      {' '}
                    </span>
                    {r.cashierExplanation}
                    {r.cashierExplainedBy ? ` — ${r.cashierExplainedBy}` : ''}
                  </div>
                )}

                {!r.cashierExplanation && explainId === r.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className={cn(cashInputCls, 'flex-1')}
                      placeholder="Explicación del comprobante confirmado"
                      value={explainText}
                      onChange={e => setExplainText(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={pending || explainText.trim() === ''}
                      onClick={() =>
                        run(
                          () => recordTransferExplanation(r.id, explainText),
                          () => {
                            setExplainId(null);
                            setExplainText('');
                          },
                        )}
                    >
                      Guardar
                    </Button>
                  </div>
                )}

                {!r.cashierExplanation && explainId !== r.id && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={pending}
                    onClick={() => {
                      setExplainId(r.id);
                      setExplainText('');
                    }}
                  >
                    Explicar comprobante
                  </Button>
                )}

                {r.salePaymentId && reclassifyId !== r.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3 ml-2"
                    disabled={pending}
                    onClick={() => {
                      setReclassifyId(r.id);
                      setReclassifyMethod('Efectivo');
                      setReclassifyAmount(r.expectedAmount);
                    }}
                  >
                    Fue error de carga
                  </Button>
                )}

                {r.salePaymentId && reclassifyId === r.id && (
                  <div className="
                    mt-3 space-y-2 rounded-lg border border-border bg-background
                    p-3
                  "
                  >
                    <div className="text-xs text-muted-foreground">
                      No era una transferencia: reclasificá a su método real.
                      Ajusta el efectivo esperado y saca esta transferencia de la
                      cola.
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={cn(cashInputCls, 'max-w-40')}
                        placeholder="Método real (ej: Efectivo)"
                        value={reclassifyMethod}
                        onChange={e => setReclassifyMethod(e.target.value)}
                      />
                      <input
                        className={cn(cashInputCls, 'max-w-32')}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        value={reclassifyAmount}
                        onChange={e => setReclassifyAmount(e.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={
                          pending
                          || reclassifyMethod.trim() === ''
                          || reclassifyAmount === ''
                        }
                        onClick={() =>
                          run(
                            () =>
                              reclassifySalePayment(
                                r.salePaymentId ?? '',
                                reclassifyMethod,
                                reclassifyAmount,
                              ),
                            () => setReclassifyId(null),
                          )}
                      >
                        Reclasificar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setReclassifyId(null)}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3.5" />
        <span>
          Estás verificando. Confirmar, marcar o corregir no abre ni cierra
          cajas — eso se hace en el punto de cobro.
        </span>
      </div>
    </div>
  );
}
