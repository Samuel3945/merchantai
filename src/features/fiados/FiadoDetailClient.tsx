'use client';

import type { ClientDetail, FiadoTimelineEntry } from '@/actions/fiados';
import { useState, useTransition } from 'react';
import { abonarFiado, extenderPlazo } from '@/actions/fiados';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { dueStateLabel, FIADO_PAYMENT_METHODS } from '@/libs/fiados-shared';
import { Link, useRouter } from '@/libs/I18nNavigation';
import { cn } from '@/utils/Helpers';
import {
  DUE_STATE_META,
  formatDate,
  formatDateTime,
  formatMoney,
} from './ui';

const inputCls
  = 'flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30';

const METHOD_LABEL = new Map<string, string>(
  FIADO_PAYMENT_METHODS.map(m => [m.value, m.label]),
);

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function timelineCopy(m: FiadoTimelineEntry): {
  title: string;
  amount: string | null;
  detail: string | null;
  tone: 'in' | 'out' | 'neutral';
} {
  switch (m.type) {
    case 'charge':
      return {
        title: 'Venta fiada',
        amount: `+ ${formatMoney(m.amount)}`,
        detail: m.note,
        tone: 'out',
      };
    case 'payment': {
      const label = m.method ? METHOD_LABEL.get(m.method) ?? m.method : '';
      return {
        title: `Abono ${label}`.trim(),
        amount: `− ${formatMoney(m.amount)}`,
        detail: m.note,
        tone: 'in',
      };
    }
    case 'extension':
      return {
        title: 'Plazo extendido',
        amount: null,
        detail: `${formatDate(m.dueDateBefore)} → ${formatDate(m.dueDateAfter)}${m.note ? ` · ${m.note}` : ''}`,
        tone: 'neutral',
      };
    case 'writeoff':
      return {
        title: 'Deuda condonada',
        amount: m.amount ? `− ${formatMoney(m.amount)}` : null,
        detail: m.note,
        tone: 'neutral',
      };
    default:
      return {
        title: 'Ajuste',
        amount: m.amount ? formatMoney(m.amount) : null,
        detail: m.note,
        tone: 'neutral',
      };
  }
}

function Timeline({ entries }: { entries: FiadoTimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">Sin movimientos.</div>
    );
  }
  // Newest first reads best for a ledger feed.
  const ordered = [...entries].reverse();
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {ordered.map((m) => {
        const c = timelineCopy(m);
        return (
          <li key={m.id} className="relative">
            <span
              className={cn(
                `
                  absolute top-1.5 left-[-1.42rem] size-2.5 rounded-full ring-4
                  ring-background
                `,
                c.tone === 'in'
                  ? 'bg-emerald-500'
                  : c.tone === 'out'
                    ? 'bg-primary'
                    : 'bg-muted-foreground',
              )}
            />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {c.title}
                  {m.type === 'payment' && m.hitCaja && (
                    <Badge
                      variant="outline"
                      className="ml-2 align-middle text-[10px]"
                    >
                      En caja
                    </Badge>
                  )}
                </div>
                {c.detail && (
                  <div className="text-xs text-muted-foreground">{c.detail}</div>
                )}
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {formatDateTime(m.createdAt)}
                  {m.createdBy && (
                    <span>
                      {' · '}
                      {m.createdBy}
                    </span>
                  )}
                </div>
              </div>
              {c.amount && (
                <div
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    c.tone === 'in'
                      ? 'text-emerald-600'
                      : c.tone === 'out'
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                  )}
                >
                  {c.amount}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Inline actions ───────────────────────────────────────────────────────────

function AbonoPanel({
  clientKey,
  balance,
  onDone,
}: {
  clientKey: string;
  balance: number;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('efectivo');
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const n = Number.parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Ingresá un monto válido');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await abonarFiado({
          clientKey,
          amount: n,
          method,
          note: note.trim() || null,
        });
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al abonar');
      }
    });
  }

  return (
    <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
      <div className="
        grid grid-cols-1 gap-2.5
        sm:grid-cols-3
      "
      >
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder={`Monto (saldo ${formatMoney(balance)})`}
          className={inputCls}
        />
        <select
          value={method}
          onChange={e => setMethod(e.target.value)}
          className={inputCls}
        >
          {FIADO_PAYMENT_METHODS.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Notas (opcional)"
          className={inputCls}
        />
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Procesando…' : 'Confirmar abono'}
        </Button>
      </div>
    </div>
  );
}

function ExtenderPanel({
  fiadoId,
  onDone,
}: {
  fiadoId: string;
  onDone: () => void;
}) {
  const [newDate, setNewDate] = useState(() => todayPlus(15));
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await extenderPlazo({ fiadoId, newDueDate: newDate, reason: reason.trim() || null });
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al extender');
      }
    });
  }

  return (
    <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
      <div className="
        grid grid-cols-1 gap-2.5
        sm:grid-cols-2
      "
      >
        <input
          type="date"
          min={todayPlus(1)}
          value={newDate}
          onChange={e => setNewDate(e.target.value)}
          className={inputCls}
        />
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Motivo (opcional)"
          className={inputCls}
        />
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Guardando…' : 'Extender plazo'}
        </Button>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function FiadoDetailClient({ detail }: { detail: ClientDetail }) {
  const router = useRouter();
  const [panel, setPanel] = useState<null | 'abono' | 'extender'>(null);
  const { client, fiados, timeline } = detail;
  const meta = DUE_STATE_META[client.dueState];
  const isPaid = client.balance <= 0;
  // Extend operates on the most-urgent still-pending fiado.
  const urgentFiadoId
    = fiados.find(f => f.status === 'pending')?.id ?? fiados[0]?.id ?? '';

  function done() {
    setPanel(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/fiados"
        className="
          text-sm text-muted-foreground
          hover:underline
        "
      >
        ← Volver a fiados
      </Link>

      <div className="
        grid grid-cols-1 gap-4
        lg:grid-cols-3
      "
      >
        {/* Summary */}
        <div className="
          space-y-4
          lg:col-span-1
        "
        >
          <div className={cn(`
            rounded-xl border border-l-4 bg-card p-5 shadow-sm
          `, meta.tint)}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-lg font-semibold">{client.name}</div>
              <Badge variant={meta.badge} className={meta.badgeClassName}>
                {dueStateLabel(client.dueState, client.dueDays)}
              </Badge>
            </div>
            {client.phone && (
              <a
                href={`tel:${client.phone}`}
                className="
                  text-xs text-muted-foreground
                  hover:underline
                "
              >
                {client.phone}
              </a>
            )}

            <div className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Saldo pendiente</span>
                <span className="font-semibold tabular-nums">{formatMoney(client.balance)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Abonado</span>
                <span className="tabular-nums">{formatMoney(client.paid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Monto original</span>
                <span className="tabular-nums">{formatMoney(client.original)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Vence</span>
                <span>{formatDate(client.dueDate)}</span>
              </div>
            </div>

            <div className="
              mt-3 h-2 w-full overflow-hidden rounded-full bg-muted
            "
            >
              <div
                className={cn('h-full rounded-full', meta.bar)}
                style={{ width: `${Math.max(0, Math.min(100, client.pct))}%` }}
              />
            </div>
            <div className="mt-1 text-right text-xs text-muted-foreground">
              {client.pct}
              % pagado
            </div>

            {!isPaid && (
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setPanel(p => (p === 'abono' ? null : 'abono'))}
                >
                  Registrar abono
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPanel(p => (p === 'extender' ? null : 'extender'))}
                >
                  Extender plazo
                </Button>
              </div>
            )}
          </div>

          {panel === 'abono' && (
            <AbonoPanel clientKey={client.clientKey} balance={client.balance} onDone={done} />
          )}
          {panel === 'extender' && urgentFiadoId && (
            <ExtenderPanel fiadoId={urgentFiadoId} onDone={done} />
          )}

          {/* Per-fiado breakdown */}
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 text-sm font-medium">Fiados de este cliente</div>
            <ul className="space-y-2">
              {fiados.map((f) => {
                const fm = DUE_STATE_META[f.dueState];
                return (
                  <li
                    key={f.id}
                    className="
                      flex items-center justify-between gap-2 rounded-lg
                      bg-muted/30 px-3 py-2 text-xs
                    "
                  >
                    <span className="text-muted-foreground">{formatDate(f.createdAt)}</span>
                    <Badge variant={fm.badge} className={cn('text-[10px]', fm.badgeClassName)}>
                      {dueStateLabel(f.dueState, f.dueDays)}
                    </Badge>
                    <span className="font-medium tabular-nums">
                      {formatMoney(f.balance)}
                      {' / '}
                      {formatMoney(f.original)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Timeline */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border bg-card p-5">
            <div className="mb-4 text-sm font-medium">Historial de movimientos</div>
            <Timeline entries={timeline} />
          </div>
        </div>
      </div>
    </div>
  );
}
