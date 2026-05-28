'use client';

import type { FiadoClient, FiadoRisk, GetPendingFiadosResult } from '@/actions/fiados';
import { useState, useTransition } from 'react';
import {
  abonarFiado,

  getPendingFiados,
  settleFiados,
} from '@/actions/fiados';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeZone: 'America/Bogota',
});

function formatMoney(n: number): string {
  return moneyFmt.format(n);
}

const riskCopy: Record<FiadoRisk, { label: string; badge: 'destructive' | 'secondary' | 'outline'; tint: string }> = {
  high: {
    label: 'Urgente',
    badge: 'destructive',
    tint: 'border-l-destructive',
  },
  mid: {
    label: 'Recordar',
    badge: 'secondary',
    tint: 'border-l-amber-500',
  },
  low: {
    label: 'Al día',
    badge: 'outline',
    tint: 'border-l-emerald-500',
  },
};

const paymentMethods = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
  { value: 'transferencia', label: 'Transferencia' },
];

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'urgent' | 'mid' | 'ok';
}) {
  const toneCls
    = tone === 'urgent'
      ? 'border-destructive/40 bg-destructive/5'
      : tone === 'mid'
        ? 'border-amber-500/40 bg-amber-500/5'
        : tone === 'ok'
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-border bg-background';
  return (
    <div className={cn('rounded-md border p-4', toneCls)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function AbonarForm({
  clientKey,
  maxOwed,
  onDone,
  onCancel,
}: {
  clientKey: string;
  maxOwed: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('efectivo');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const n = Number.parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Ingrese un monto válido');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await abonarFiado(clientKey, n, method);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al abonar');
      }
    });
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="
        grid grid-cols-1 gap-2
        sm:grid-cols-2
      "
      >
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Monto (máx
            {' '}
            {formatMoney(maxOwed)}
            )
          </label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0"
            className={inputCls}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Método</label>
          <select
            value={method}
            onChange={e => setMethod(e.target.value)}
            className={inputCls}
          >
            {paymentMethods.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
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

function ClientCard({
  client,
  onChange,
}: {
  client: FiadoClient;
  onChange: () => void;
}) {
  const [abonarOpen, setAbonarOpen] = useState(false);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const risk = riskCopy[client.risk];

  function markPaid() {
    setConfirmPaid(false);
    startTransition(async () => {
      try {
        await settleFiados(client.sales.map(s => s.id));
        onChange();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      }
    });
  }

  return (
    <div className={cn(
      'rounded-md border border-l-4 bg-background p-4 shadow-sm',
      risk.tint,
    )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-base font-semibold">{client.name}</div>
            <Badge variant={risk.badge}>{risk.label}</Badge>
          </div>
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
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Debe</div>
          <div className="text-lg font-semibold tabular-nums">
            {formatMoney(client.totalOwed)}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-sm bg-muted/40 px-2 py-1">
          <span className="text-muted-foreground">Más viejo: </span>
          <span className="font-medium">
            {client.oldestDays}
            {' '}
            {client.oldestDays === 1 ? 'día' : 'días'}
          </span>
        </div>
        <div className="rounded-sm bg-muted/40 px-2 py-1">
          <span className="text-muted-foreground">Ventas: </span>
          <span className="font-medium">{client.sales.length}</span>
        </div>
      </div>

      <details className="mt-3">
        <summary className="
          cursor-pointer text-xs text-muted-foreground
          hover:text-foreground
        "
        >
          Ver ventas
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {client.sales.map(s => (
            <li
              key={s.id}
              className="
                flex items-center justify-between gap-2 rounded-sm bg-muted/30
                px-2 py-1
              "
            >
              <span className="font-mono">
                #
                {s.id.slice(0, 6)}
              </span>
              <span className="text-muted-foreground">
                {dateFmt.format(new Date(s.createdAt))}
                {' '}
                ·
                {' '}
                {s.daysOld}
                d
              </span>
              <span className="font-medium tabular-nums">
                {formatMoney(s.pending)}
                {s.paid > 0 && (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    /
                    {formatMoney(s.total)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setAbonarOpen(v => !v)}
          disabled={pending}
        >
          {abonarOpen ? 'Cerrar abono' : 'Abonar'}
        </Button>
        {confirmPaid
          ? (
              <>
                <Button size="sm" onClick={markPaid} disabled={pending}>
                  {pending ? 'Guardando…' : 'Sí, marcar pagado'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmPaid(false)}
                  disabled={pending}
                >
                  Cancelar
                </Button>
              </>
            )
          : (
              <Button
                size="sm"
                onClick={() => setConfirmPaid(true)}
                disabled={pending}
              >
                Marcar como pagado
              </Button>
            )}
      </div>

      {abonarOpen && (
        <AbonarForm
          clientKey={client.clientKey}
          maxOwed={client.totalOwed}
          onDone={() => {
            setAbonarOpen(false);
            onChange();
          }}
          onCancel={() => setAbonarOpen(false)}
        />
      )}
    </div>
  );
}

export function FiadosClient({ initial }: { initial: GetPendingFiadosResult }) {
  const [data, setData] = useState<GetPendingFiadosResult>(initial);
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<'all' | FiadoRisk>('all');

  function reload() {
    startTransition(async () => {
      const fresh = await getPendingFiados();
      setData(fresh);
    });
  }

  const filtered
    = filter === 'all'
      ? data.clients
      : data.clients.filter(c => c.risk === filter);

  return (
    <div className="space-y-6">
      <div className="
        grid grid-cols-2 gap-3
        lg:grid-cols-5
      "
      >
        <StatCard
          label="Total adeudado"
          value={formatMoney(data.stats.total_owed)}
          hint={`${data.stats.total_clients} ${data.stats.total_clients === 1 ? 'cliente' : 'clientes'}`}
        />
        <StatCard
          label="Urgentes"
          value={String(data.stats.urgent)}
          hint=">= 7 días"
          tone="urgent"
        />
        <StatCard
          label="Recordar"
          value={String(data.stats.remind)}
          hint=">= 3 días"
          tone="mid"
        />
        <StatCard
          label="Al día"
          value={String(data.stats.ok)}
          hint="< 3 días"
          tone="ok"
        />
        <StatCard
          label="Clientes"
          value={String(data.stats.total_clients)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'high', 'mid', 'low'] as const).map((f) => {
          const labels = {
            all: 'Todos',
            high: 'Urgentes',
            mid: 'Recordar',
            low: 'Al día',
          };
          return (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'secondary'}
              onClick={() => setFilter(f)}
            >
              {labels[f]}
            </Button>
          );
        })}
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

      {filtered.length === 0
        ? (
            <div className="
              rounded-md border bg-background p-10 text-center text-sm
              text-muted-foreground
            "
            >
              {data.clients.length === 0
                ? 'No hay fiados pendientes 🎉'
                : 'Ningún cliente coincide con el filtro'}
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
    </div>
  );
}
