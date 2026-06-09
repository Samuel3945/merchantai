'use client';

import type { ClientDebt, FiadosOverview } from '@/actions/fiados';
import type { FiadoDueState } from '@/libs/fiados-shared';
import { useId, useState, useTransition } from 'react';
import {
  abonarFiado,
  extenderPlazo,
  fetchFiadosHistory,
  fetchFiadosOverview,
} from '@/actions/fiados';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  dueStateLabel,
  FIADO_PAYMENT_METHODS,
} from '@/libs/fiados-shared';
import { Link } from '@/libs/I18nNavigation';
import { cn } from '@/utils/Helpers';
import { DUE_STATE_META, formatDate, formatMoney, relativeTime } from './ui';

const inputCls
  = 'flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30';

// ── Metric cards ─────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'danger' | 'warn' | 'ok';
}) {
  const toneCls
    = tone === 'danger'
      ? 'border-destructive/30 bg-destructive/5'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/5'
        : tone === 'ok'
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-border bg-card';
  return (
    <div className={cn('rounded-xl border p-4', toneCls)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ── Progress bar (saldo pagado) ──────────────────────────────────────────────

function ProgressBar({ pct, state }: { pct: number; state: FiadoDueState }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-all', DUE_STATE_META[state].bar)}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

// ── Abono form ───────────────────────────────────────────────────────────────

function AbonarForm({
  client,
  onDone,
  onCancel,
}: {
  client: ClientDebt;
  onDone: () => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const amountId = `${formId}-amount`;
  const methodId = `${formId}-method`;
  const noteId = `${formId}-note`;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('efectivo');
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit() {
    const n = Number.parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Ingresá un monto válido');
      return;
    }
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await abonarFiado({
          clientKey: client.clientKey,
          amount: n,
          method,
          note: note.trim() || null,
        });
        if (method === 'efectivo' && !result.hitCaja) {
          setNotice(
            'Abono registrado. La caja está cerrada, así que no se reflejó en el efectivo; ábrela para cuadrarlo.',
          );
          setTimeout(onDone, 1800);
          return;
        }
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al abonar');
      }
    });
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border bg-muted/30 p-3">
      <div className="
        grid grid-cols-1 gap-2.5
        sm:grid-cols-2
      "
      >
        <div>
          <label
            htmlFor={amountId}
            className="text-xs font-medium text-muted-foreground"
          >
            Monto (saldo
            {' '}
            {formatMoney(client.balance)}
            )
          </label>
          <input
            id={amountId}
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label
            htmlFor={methodId}
            className="text-xs font-medium text-muted-foreground"
          >
            Método
          </label>
          <Select
            id={methodId}
            value={method}
            onValueChange={setMethod}
            options={FIADO_PAYMENT_METHODS.map(m => ({
              value: m.value,
              label: m.label,
            }))}
          />
        </div>
      </div>
      <div>
        <label
          htmlFor={noteId}
          className="text-xs font-medium text-muted-foreground"
        >
          Notas (opcional)
        </label>
        <input
          id={noteId}
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Ej: abona la mitad"
          className={inputCls}
        />
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      {notice && <div className="text-xs text-amber-600">{notice}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Procesando…' : 'Confirmar abono'}
        </Button>
      </div>
    </div>
  );
}

// ── Extender plazo form ──────────────────────────────────────────────────────

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function ExtenderForm({
  client,
  onDone,
  onCancel,
}: {
  client: ClientDebt;
  onDone: () => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const dateId = `${formId}-date`;
  const reasonId = `${formId}-reason`;
  const [newDate, setNewDate] = useState(() => todayPlus(15));
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      setError('Elegí una fecha válida');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await extenderPlazo({
          fiadoId: client.fiadoIds[0] ?? '',
          newDueDate: newDate,
          reason: reason.trim() || null,
        });
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al extender');
      }
    });
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border bg-muted/30 p-3">
      <div className="
        grid grid-cols-1 gap-2.5
        sm:grid-cols-2
      "
      >
        <div>
          <label
            htmlFor={dateId}
            className="text-xs font-medium text-muted-foreground"
          >
            Nueva fecha de pago
          </label>
          <input
            id={dateId}
            type="date"
            min={todayPlus(1)}
            value={newDate}
            onChange={e => setNewDate(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label
            htmlFor={reasonId}
            className="text-xs font-medium text-muted-foreground"
          >
            Motivo (opcional)
          </label>
          <input
            id={reasonId}
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Ej: pidió una semana más"
            className={inputCls}
          />
        </div>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Guardando…' : 'Extender plazo'}
        </Button>
      </div>
    </div>
  );
}

// ── Client card ──────────────────────────────────────────────────────────────

function ClientCard({
  client,
  onChange,
  history = false,
}: {
  client: ClientDebt;
  onChange: () => void;
  history?: boolean;
}) {
  const [open, setOpen] = useState<null | 'abono' | 'extender'>(null);
  const meta = DUE_STATE_META[client.dueState];

  return (
    <div
      className={cn(
        `
          rounded-xl border border-l-4 bg-card p-4 shadow-sm transition-shadow
          hover:shadow-md
        `,
        meta.tint,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">{client.name}</div>
          {client.phone && (
            <a
              href={`tel:${client.phone}`}
              className="
                mt-0.5 inline-block text-xs text-muted-foreground
                hover:underline
              "
            >
              {client.phone}
            </a>
          )}
        </div>
        <Badge variant={meta.badge} className={meta.badgeClassName}>
          {dueStateLabel(client.dueState, client.dueDays)}
        </Badge>
      </div>

      {/* Due date — the single most important date for a tendero scanning cards. */}
      <div className="mt-1.5 text-xs text-muted-foreground">
        {history ? 'Pagado' : `Vence: ${formatDate(client.dueDate)}`}
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">
            {history ? 'Monto original' : 'Saldo pendiente'}
          </div>
          <div className="text-2xl font-semibold tabular-nums">
            {formatMoney(history ? client.original : client.balance)}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {history
            ? (
                <>
                  {formatMoney(client.paid)}
                  {' pagado'}
                </>
              )
            : (
                <>
                  {formatMoney(client.paid)}
                  {' de '}
                  {formatMoney(client.original)}
                  <div className="font-medium text-foreground">
                    {client.pct}
                    % pagado
                  </div>
                </>
              )}
        </div>
      </div>

      <div className="mt-2">
        <ProgressBar pct={client.pct} state={client.dueState} />
      </div>

      <div className="
        mt-3 flex items-center justify-between text-xs text-muted-foreground
      "
      >
        <span>
          Últ. movimiento
          {' '}
          {relativeTime(client.lastMovementAt)}
        </span>
        {client.fiadoCount > 1 && (
          <span>
            {client.fiadoCount}
            {' '}
            fiados
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!history && (
          <Button
            size="sm"
            onClick={() => setOpen(o => (o === 'abono' ? null : 'abono'))}
            disabled={open === 'extender'}
          >
            Registrar abono
          </Button>
        )}
        <Button size="sm" variant="secondary" asChild>
          <Link href={`/dashboard/fiados/${encodeURIComponent(client.clientKey)}`}>
            Ver detalle
          </Link>
        </Button>
        {!history && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(o => (o === 'extender' ? null : 'extender'))}
            disabled={open === 'abono'}
          >
            Extender plazo
          </Button>
        )}
      </div>

      {open === 'abono' && (
        <AbonarForm
          client={client}
          onDone={() => {
            setOpen(null);
            onChange();
          }}
          onCancel={() => setOpen(null)}
        />
      )}
      {open === 'extender' && (
        <ExtenderForm
          client={client}
          onDone={() => {
            setOpen(null);
            onChange();
          }}
          onCancel={() => setOpen(null)}
        />
      )}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed bg-card p-12 text-center">
      <div className="text-4xl">🎉</div>
      <div className="mt-3 text-lg font-semibold">Excelente</div>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        No tienes clientes con deudas pendientes. Cuando registres una venta
        fiada aparecerán aquí automáticamente.
      </p>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

type Filter = 'all' | FiadoDueState;
type Tab = 'pending' | 'history';

// "Al día" was dropped: a tendero reads it as "no debe nada", but it actually
// meant "debe, sin apuro" — clashing with "Pagados" (which IS "no debe nada").
// Pending clients without a near due date already show under "Todos".
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'overdue', label: 'Vencidos' },
  { value: 'due_soon', label: 'Próximos a vencer' },
];

export function FiadosClient({ initial }: { initial: FiadosOverview }) {
  const [data, setData] = useState<FiadosOverview>(initial);
  const [history, setHistory] = useState<ClientDebt[] | null>(null);
  const [tab, setTab] = useState<Tab>('pending');
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, startTransition] = useTransition();

  function reload() {
    startTransition(async () => {
      const [fresh, hist] = await Promise.all([
        fetchFiadosOverview(),
        history !== null ? fetchFiadosHistory() : Promise.resolve(null),
      ]);
      setData(fresh);
      if (hist) {
        setHistory(hist);
      }
    });
  }

  function openHistory() {
    setTab('history');
    if (history === null) {
      startTransition(async () => {
        setHistory(await fetchFiadosHistory());
      });
    }
  }

  const { metrics } = data;
  const filtered
    = filter === 'all'
      ? data.clients
      : data.clients.filter(c => c.dueState === filter);

  return (
    <div className="space-y-6">
      <div className="
        grid grid-cols-2 gap-3
        lg:grid-cols-5
      "
      >
        <MetricCard
          label="Dinero pendiente"
          value={formatMoney(metrics.pendingTotal)}
          hint="Total por cobrar"
        />
        <MetricCard
          label="Clientes con deuda"
          value={String(metrics.clientsWithDebt)}
        />
        <MetricCard
          label="Vencidos"
          value={String(metrics.overdue)}
          hint="Pasaron la fecha"
          tone="danger"
        />
        <MetricCard
          label="Próximos a vencer"
          value={String(metrics.dueSoon)}
          hint="Hoy o pronto"
          tone="warn"
        />
        <MetricCard
          label="Recuperado este mes"
          value={formatMoney(metrics.recoveredThisMonth)}
          tone="ok"
        />
      </div>

      <div className="flex items-center gap-2 border-b">
        <button
          type="button"
          onClick={() => setTab('pending')}
          className={cn(
            'border-b-2 px-1 pb-2 text-sm font-medium',
            tab === 'pending'
              ? 'border-primary text-foreground'
              : `
                border-transparent text-muted-foreground
                hover:text-foreground
              `,
          )}
        >
          Pendientes
        </button>
        <button
          type="button"
          onClick={openHistory}
          className={cn(
            'border-b-2 px-1 pb-2 text-sm font-medium',
            tab === 'history'
              ? 'border-primary text-foreground'
              : `
                border-transparent text-muted-foreground
                hover:text-foreground
              `,
          )}
        >
          Pagados
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={reload}
          disabled={pending}
          className="ml-auto"
        >
          {pending ? 'Actualizando…' : 'Refrescar'}
        </Button>
      </div>

      {tab === 'pending'
        ? (
            <>
              <div className="flex flex-wrap gap-2">
                {FILTERS.map(f => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={filter === f.value ? 'default' : 'secondary'}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>

              {data.clients.length === 0
                ? (
                    <EmptyState />
                  )
                : filtered.length === 0
                  ? (
                      <div className="
                        rounded-xl border bg-card p-10 text-center text-sm
                        text-muted-foreground
                      "
                      >
                        Ningún cliente coincide con el filtro.
                      </div>
                    )
                  : (
                      <div className="
                        grid grid-cols-1 gap-3
                        md:grid-cols-2
                        xl:grid-cols-3
                      "
                      >
                        {filtered.map(c => (
                          <ClientCard key={c.clientKey} client={c} onChange={reload} />
                        ))}
                      </div>
                    )}
            </>
          )
        : (
            history === null
              ? (
                  <div className="
                    p-10 text-center text-sm text-muted-foreground
                  "
                  >
                    Cargando historial…
                  </div>
                )
              : history.length === 0
                ? (
                    <div className="
                      rounded-xl border bg-card p-10 text-center text-sm
                      text-muted-foreground
                    "
                    >
                      Todavía no hay fiados pagados en el historial.
                    </div>
                  )
                : (
                    <div className="
                      grid grid-cols-1 gap-3
                      md:grid-cols-2
                      xl:grid-cols-3
                    "
                    >
                      {history.map(c => (
                        <ClientCard key={c.clientKey} client={c} onChange={reload} history />
                      ))}
                    </div>
                  )
          )}
    </div>
  );
}
