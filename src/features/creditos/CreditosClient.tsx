'use client';

import type { ClientDebt, CreditosOverview } from '@/actions/creditos';
import type { AbonoMethod, CreditoDueState } from '@/libs/creditos-shared';
import type { RangeOption } from '@/utils/DateRange';
import { CheckCircle2, Clock, Search, X } from 'lucide-react';
import { useId, useMemo, useState, useTransition } from 'react';
import {
  abonarCredito,
  extenderPlazo,
  fetchCreditosHistory,
  fetchCreditosOverview,
} from '@/actions/creditos';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  defaultAbonoMethod,
  dueStateLabel,
} from '@/libs/creditos-shared';
import { Link } from '@/libs/I18nNavigation';
import { addDays, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';
import { AbonoAmountField } from './AbonoAmountField';
import { AbonoMethodPicker } from './AbonoMethodPicker';
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

function ProgressBar({ pct, state }: { pct: number; state: CreditoDueState }) {
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
  methods,
  onDone,
  onCancel,
}: {
  client: ClientDebt;
  methods: AbonoMethod[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const amountId = `${formId}-amount`;
  const noteId = `${formId}-note`;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(() => defaultAbonoMethod(methods));
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
    const selected = methods.find(m => m.value === method);
    startTransition(async () => {
      try {
        const result = await abonarCredito({
          clientKey: client.clientKey,
          amount: n,
          method,
          note: note.trim() || null,
        });
        if (selected?.type === 'cash' && !result.hitCaja) {
          setNotice(
            'Abono registrado. La caja está cerrada, así que no se reflejó en el efectivo; ábrela para cuadrarlo.',
          );
          setTimeout(onDone, 1800);
          return;
        }
        if (selected?.type === 'transfer') {
          setNotice(
            'Abono registrado. Queda pendiente de confirmar en caja cuando verifiques que la plata entró a la cuenta.',
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
      <AbonoAmountField
        value={amount}
        onChange={setAmount}
        balance={client.balance}
        id={amountId}
        autoFocus
      />
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          Método de pago
        </div>
        <AbonoMethodPicker
          methods={methods}
          value={method}
          onChange={setMethod}
          disabled={pending}
        />
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
          creditoId: client.creditoIds[0] ?? '',
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
  methods,
  onChange,
  history = false,
}: {
  client: ClientDebt;
  methods: AbonoMethod[];
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

      {!history && client.pendingConfirmation > 0 && (
        <div className="
          mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/40
          bg-amber-500/5 px-2.5 py-1.5 text-xs font-medium text-amber-600
          dark:text-amber-400
        "
        >
          <Clock className="size-3.5 shrink-0" aria-hidden />
          <span>
            Pendiente a confirmar en caja:
            {' '}
            {formatMoney(client.pendingConfirmation)}
          </span>
        </div>
      )}

      <div className="
        mt-3 flex items-center justify-between text-xs text-muted-foreground
      "
      >
        <span>
          Últ. movimiento
          {' '}
          {relativeTime(client.lastMovementAt)}
        </span>
        {client.creditoCount > 1 && (
          <span>
            {client.creditoCount}
            {' '}
            créditos
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
          <Link href={`/dashboard/creditos/${encodeURIComponent(client.clientKey)}`}>
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
          methods={methods}
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
      <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden />
      <div className="mt-3 text-lg font-semibold">Excelente</div>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        No tienes clientes con deudas pendientes. Cuando registres una venta
        fiada aparecerán aquí automáticamente.
      </p>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

type Filter = 'all' | CreditoDueState;
type Tab = 'pending' | 'history';

// "Al día" was dropped: a tendero reads it as "no debe nada", but it actually
// meant "debe, sin apuro" — clashing with "Pagados" (which IS "no debe nada").
// Pending clients without a near due date already show under "Todos".
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'overdue', label: 'Vencidos' },
  { value: 'due_soon', label: 'Próximos a vencer' },
];

type SortKey = 'balance_desc' | 'balance_asc' | 'oldest' | 'recent' | 'name';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'balance_desc', label: 'Mayor deuda' },
  { value: 'balance_asc', label: 'Menor deuda' },
  { value: 'oldest', label: 'Debe hace más tiempo' },
  { value: 'recent', label: 'Más reciente' },
  { value: 'name', label: 'Nombre (A–Z)' },
];

// Pending cards rank by outstanding balance; paid history has no balance left,
// so it ranks by the original amount instead.
function amountOf(c: ClientDebt, history: boolean): number {
  return history ? c.original : c.balance;
}

// Single client-side pipeline: due-state chips (pending only), free-text search
// over name + phone digits, due-date range, then sort. Pure so the visible list
// recomputes from one memo.
function filterAndSortClients(
  list: ClientDebt[],
  opts: {
    search: string;
    start: string;
    end: string;
    sort: SortKey;
    dueFilter: Filter;
    history: boolean;
  },
): ClientDebt[] {
  const { search, start, end, sort, dueFilter, history } = opts;
  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');

  let out = list;
  if (!history && dueFilter !== 'all') {
    out = out.filter(c => c.dueState === dueFilter);
  }
  if (q) {
    out = out.filter(
      c =>
        c.name.toLowerCase().includes(q)
        || (qDigits.length > 0 && c.phone.replace(/\D/g, '').includes(qDigits)),
    );
  }
  if (start && end) {
    out = out.filter((c) => {
      const d = c.dueDate.slice(0, 10);
      return d >= start && d <= end;
    });
  }

  return [...out].sort((a, b) => {
    switch (sort) {
      case 'balance_asc':
        return amountOf(a, history) - amountOf(b, history);
      case 'oldest':
        return a.dueDate.localeCompare(b.dueDate);
      case 'recent':
        return b.dueDate.localeCompare(a.dueDate);
      case 'name':
        return a.name.localeCompare(b.name, 'es');
      case 'balance_desc':
      default:
        return amountOf(b, history) - amountOf(a, history);
    }
  });
}

export function CreditosClient({
  initial,
  paymentMethods,
}: {
  initial: CreditosOverview;
  paymentMethods: AbonoMethod[];
}) {
  const [data, setData] = useState<CreditosOverview>(initial);
  const [history, setHistory] = useState<ClientDebt[] | null>(null);
  const [tab, setTab] = useState<Tab>('pending');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('balance_desc');
  const [pending, startTransition] = useTransition();

  // Credito-specific presets filter by due date (overdue + upcoming), unlike the
  // dashboard's past-only windows. The range picker itself is the same.
  const presetOptions = useMemo<RangeOption[]>(() => {
    const today = todayBogota();
    const [y, m] = today.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
    const endOfMonth = `${today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    return [
      { key: 'overdue', label: 'Vencidos', range: { start: addDays(today, -365), end: addDays(today, -1) } },
      { key: 'today', label: 'Vencen hoy', range: { start: today, end: today } },
      { key: '7d', label: 'Próximos 7 días', range: { start: today, end: addDays(today, 7) } },
      { key: '30d', label: 'Próximos 30 días', range: { start: today, end: addDays(today, 30) } },
      { key: 'mtd', label: 'Este mes', range: { start: `${today.slice(0, 7)}-01`, end: endOfMonth } },
    ];
  }, []);
  // Due dates can sit up to ~2 years out, so the calendar must allow the future.
  const maxDate = useMemo(() => addDays(todayBogota(), 730), []);

  function reload() {
    startTransition(async () => {
      const [fresh, hist] = await Promise.all([
        fetchCreditosOverview(),
        history !== null ? fetchCreditosHistory() : Promise.resolve(null),
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
        setHistory(await fetchCreditosHistory());
      });
    }
  }

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setStart(next.start);
    setEnd(next.end);
    setActivePreset(next.preset);
  }

  function clearRange() {
    setStart('');
    setEnd('');
    setActivePreset(null);
  }

  function clearAllFilters() {
    setSearch('');
    clearRange();
    setFilter('all');
  }

  const { metrics } = data;
  const isHistory = tab === 'history';
  const source = useMemo(
    () => (isHistory ? history ?? [] : data.clients),
    [isHistory, history, data.clients],
  );
  const visible = useMemo(
    () =>
      filterAndSortClients(source, {
        search,
        start,
        end,
        sort,
        dueFilter: filter,
        history: isHistory,
      }),
    [source, search, start, end, sort, filter, isHistory],
  );
  const sourceCount = isHistory ? history?.length ?? 0 : data.clients.length;
  const hasActiveFilters
    = search.trim() !== '' || (start !== '' && end !== '') || filter !== 'all';

  const listSection = (() => {
    if (isHistory && history === null) {
      return (
        <div className="p-10 text-center text-sm text-muted-foreground">
          Cargando historial…
        </div>
      );
    }
    if (sourceCount === 0) {
      return isHistory
        ? (
            <div className="
              rounded-xl border bg-card p-10 text-center text-sm
              text-muted-foreground
            "
            >
              Todavía no hay créditos pagados en el historial.
            </div>
          )
        : (
            <EmptyState />
          );
    }
    if (visible.length === 0) {
      return (
        <div className="
          flex flex-col items-center gap-3 rounded-xl border bg-card p-10
          text-center
        "
        >
          <p className="text-sm text-muted-foreground">
            Ningún cliente coincide con los filtros.
          </p>
          {hasActiveFilters && (
            <Button size="sm" variant="secondary" onClick={clearAllFilters}>
              Limpiar filtros
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="
        grid grid-cols-1 gap-3
        md:grid-cols-2
        xl:grid-cols-3
      "
      >
        {visible.map(c => (
          <ClientCard
            key={c.clientKey}
            client={c}
            methods={paymentMethods}
            onChange={reload}
            history={isHistory}
          />
        ))}
      </div>
    );
  })();

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

      {/* Toolbar: search + due-date range + sort, then the result count. */}
      <div className="space-y-3">
        <div className="
          flex flex-col gap-2
          sm:flex-row sm:items-center
        "
        >
          <div className="
            relative
            sm:flex-1
          "
          >
            <Search className="
              pointer-events-none absolute top-1/2 left-3 size-4
              -translate-y-1/2 text-muted-foreground
            "
            />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre o teléfono…"
              aria-label="Buscar crédito"
              className="
                h-9 w-full rounded-lg border border-input bg-card px-9 text-sm
                outline-none
                focus-visible:border-primary focus-visible:ring-2
                focus-visible:ring-ring/30
              "
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Limpiar búsqueda"
                className="
                  absolute top-1/2 right-2 flex size-6 -translate-y-1/2
                  items-center justify-center rounded-md text-muted-foreground
                  transition-colors
                  hover:bg-accent hover:text-foreground
                "
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <DateRangePicker
            start={start}
            end={end}
            compare={false}
            activePreset={activePreset}
            presets={presetOptions}
            maxDate={maxDate}
            showCompare={false}
            onApply={applyRange}
            onClear={clearRange}
            triggerClassName="h-9 sm:w-56"
          />
          <Select
            value={sort}
            onValueChange={v => setSort(v as SortKey)}
            options={SORT_OPTIONS}
            aria-label="Ordenar créditos"
            className="
              h-9
              sm:w-52
            "
          />
        </div>

        {tab === 'pending' && (
          <div className="flex flex-wrap items-center gap-2">
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
        )}

        {sourceCount > 0 && (
          <div className="
            flex items-center justify-between gap-2 text-xs
            text-muted-foreground
          "
          >
            <span>
              Mostrando
              {' '}
              {visible.length}
              {' de '}
              {sourceCount}
              {isHistory ? ' pagados' : ' con deuda'}
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="
                  font-medium text-primary
                  hover:underline
                "
              >
                Limpiar filtros
              </button>
            )}
          </div>
        )}
      </div>

      {listSection}
    </div>
  );
}
