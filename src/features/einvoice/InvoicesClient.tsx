'use client';

import type { InvoiceRow, InvoicesPayload, InvoiceTab } from '@/actions/einvoice';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  ReceiptText,
  RefreshCw,
  Send,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  emitInvoice,

  listInvoices,
} from '@/actions/einvoice';
import { fmtMoney } from '@/features/reports/format';

const TABS: { id: InvoiceTab; label: string; icon: typeof Clock }[] = [
  { id: 'all', label: 'Todas', icon: ReceiptText },
  { id: 'pending', label: 'Pendientes', icon: Clock },
  { id: 'emitted', label: 'Emitidas', icon: CheckCircle2 },
  { id: 'error', label: 'Con error', icon: AlertCircle },
];

function statusBadge(status: string | null) {
  if (status === 'emitted') {
    return {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      label: 'Emitida',
      Icon: CheckCircle2,
    };
  }
  if (status === 'error' || status === 'failed') {
    return {
      cls: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
      label: 'Con error',
      Icon: AlertCircle,
    };
  }
  return {
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    label: 'Pendiente',
    Icon: Clock,
  };
}

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
});
const timeFmt = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
});

export function InvoicesClient({
  initialData,
  initialTab,
}: {
  initialData: InvoicesPayload;
  initialTab: InvoiceTab;
}) {
  const [tab, setTab] = useState<InvoiceTab>(initialTab);
  const [data, setData] = useState<InvoicesPayload>(initialData);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  const refetch = (next: InvoiceTab) => {
    setError('');
    startTransition(async () => {
      try {
        setData(await listInvoices(next));
      } catch {
        setError('No se pudo cargar la lista de facturas.');
      }
    });
  };

  const selectTab = (next: InvoiceTab) => {
    setTab(next);
    refetch(next);
  };

  const handleEmit = async (saleId: string, force: boolean) => {
    setBusyId(saleId);
    setError('');
    try {
      const result = await emitInvoice(saleId, force);
      if (!result.ok) {
        setError(result.message);
      } else {
        setData(await listInvoices(tab));
      }
    } catch {
      setError('Error de red al emitir.');
    } finally {
      setBusyId(null);
    }
  };

  const { configured } = data;

  return (
    <div className="space-y-4">
      {/* Provider not configured banner */}
      {!configured && (
        <div className="
          flex items-start gap-3 rounded-lg border border-amber-500/30
          bg-amber-500/10 px-4 py-3
        "
        >
          <Info className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="flex-1">
            <p className="
              text-sm font-semibold text-amber-600
              dark:text-amber-400
            "
            >
              No tenés un proveedor de facturación configurado
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Las facturas que pidan tus clientes quedan
              {' '}
              <strong>pendientes</strong>
              . Cuando conectes Factus desde Ajustes, las emitís con un click.
            </p>
          </div>
          <Link
            href="/dashboard/settings"
            className="
              flex h-9 shrink-0 items-center gap-1.5 rounded-md border
              border-input bg-background px-3 text-xs font-medium
              hover:bg-muted
            "
          >
            <Settings className="size-3.5" />
            Configurar
          </Link>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const count
            = t.id === 'all'
              ? data.stats.pending + data.stats.emitted + data.stats.error
              : data.stats[t.id];
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              className={`
                flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs
                font-semibold transition-colors
                ${
            active
              ? 'border-foreground/30 bg-muted text-foreground'
              : `
                border-transparent text-muted-foreground
                hover:text-foreground
              `
            }
              `}
            >
              <Icon className="size-4" />
              {t.label}
              <span className="
                rounded-full bg-background px-1.5 text-[10px] font-bold
                text-muted-foreground
              "
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="
          rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm
          text-red-600
          dark:text-red-400
        "
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {isPending
          ? (
              <div className="py-14 text-center text-muted-foreground">
                <Loader2 className="mx-auto size-7 animate-spin" />
              </div>
            )
          : data.items.length === 0
            ? (
                <div className="py-14 text-center text-muted-foreground">
                  <ReceiptText className="mx-auto mb-2 size-9" />
                  {tab === 'pending'
                    ? 'No hay facturas pendientes.'
                    : tab === 'emitted'
                      ? 'No hay facturas emitidas todavía.'
                      : tab === 'error'
                        ? 'No hay facturas con error.'
                        : 'No hay facturas registradas.'}
                </div>
              )
            : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="
                        border-b border-border text-[10px] font-bold
                        tracking-wider text-muted-foreground uppercase
                      "
                      >
                        <th className="px-4 py-2.5 text-left">Fecha</th>
                        <th className="px-4 py-2.5 text-left">Cliente</th>
                        <th className="px-4 py-2.5 text-left">Documento</th>
                        <th className="px-4 py-2.5 text-right">Total</th>
                        <th className="px-4 py-2.5 text-left">Estado</th>
                        <th className="px-4 py-2.5 text-left">CUFE / Número</th>
                        <th className="px-4 py-2.5 text-right">Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map(inv => (
                        <InvoiceTableRow
                          key={inv.id}
                          invoice={inv}
                          configured={configured}
                          busy={busyId === inv.id}
                          onEmit={handleEmit}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
      </div>
    </div>
  );
}

function InvoiceTableRow({
  invoice,
  configured,
  busy,
  onEmit,
}: {
  invoice: InvoiceRow;
  configured: boolean;
  busy: boolean;
  onEmit: (saleId: string, force: boolean) => void;
}) {
  const badge = statusBadge(invoice.einvoiceStatus);
  const date = new Date(invoice.createdAt);
  const isError
    = invoice.einvoiceStatus === 'error' || invoice.einvoiceStatus === 'failed';
  const emitted = invoice.einvoiceStatus === 'emitted';
  const BadgeIcon = badge.Icon;

  return (
    <tr className="
      border-b border-border
      last:border-0
      hover:bg-muted/40
    "
    >
      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
        {dateFmt.format(date)}
        <span className="block text-muted-foreground/60">
          {timeFmt.format(date)}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex max-w-[220px] items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {invoice.client.name || 'Sin nombre'}
          </span>
          {invoice.client.consumidorFinal && (
            <span className="
              shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold
              tracking-wider text-muted-foreground uppercase
            "
            >
              Genérico
            </span>
          )}
        </div>
        {(invoice.client.whatsapp || invoice.client.email) && (
          <div className="
            flex flex-wrap gap-2 text-[11px] text-muted-foreground
          "
          >
            {invoice.client.whatsapp && <span>{invoice.client.whatsapp}</span>}
            {invoice.client.email && (
              <span className="max-w-[140px] truncate">
                {invoice.client.email}
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {invoice.client.doc || '—'}
      </td>
      <td className="px-4 py-3 text-right font-bold tabular-nums">
        {fmtMoney(invoice.total)}
      </td>
      <td className="px-4 py-3">
        <span
          className={`
            inline-flex items-center gap-1 rounded-full border px-2 py-0.5
            text-[10px] font-bold tracking-wider uppercase
            ${badge.cls}
          `}
        >
          <BadgeIcon className="size-3" />
          {badge.label}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
        {invoice.einvoiceNumber && (
          <div className="text-foreground">{invoice.einvoiceNumber}</div>
        )}
        {invoice.einvoiceCufe && (
          <div className="max-w-[160px] truncate" title={invoice.einvoiceCufe}>
            {invoice.einvoiceCufe}
          </div>
        )}
        {!invoice.einvoiceNumber && !invoice.einvoiceCufe && <span>—</span>}
      </td>
      <td className="px-4 py-3 text-right">
        {emitted
          ? (
              <span className="text-[10px] font-semibold text-emerald-500">
                Lista ✓
              </span>
            )
          : (
              <button
                type="button"
                onClick={() => onEmit(invoice.id, isError)}
                disabled={busy || !configured}
                title={!configured ? 'Configurá un proveedor en Ajustes' : ''}
                className="
                  ml-auto flex h-8 items-center gap-1.5 rounded-md border
                  border-input bg-background px-3 text-xs font-medium
                  hover:bg-muted
                  disabled:cursor-not-allowed disabled:opacity-40
                "
              >
                {busy
                  ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    )
                  : isError
                    ? (
                        <RefreshCw className="size-3.5" />
                      )
                    : (
                        <Send className="size-3.5" />
                      )}
                {isError ? 'Reintentar' : 'Emitir'}
              </button>
            )}
      </td>
    </tr>
  );
}
