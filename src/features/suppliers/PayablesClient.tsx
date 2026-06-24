'use client';

import type { OpenInvoiceGroup, OpenPayable } from './actions';
import type { PaymentContainer } from '@/actions/inventory';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { InvoicePaymentModal } from './InvoicePaymentModal';
import { PayablePaymentModal } from './PayablePaymentModal';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  return cop.format(Number.isFinite(n as number) ? (n as number) : 0);
}

function formatDate(d: Date | string | null): string {
  if (!d) {
    return '—';
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function StatusBadge({ status }: { status: 'open' | 'partial' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'open'
          ? 'bg-amber-500/10 text-amber-600'
          : 'bg-blue-500/10 text-blue-600',
      )}
    >
      {status === 'open' ? 'Pendiente' : 'Parcial'}
    </span>
  );
}

/**
 * Client component for the "Compras por pagar" grouped view.
 *
 * Renders invoice groups (grouped by purchase_id). Standalone payables
 * (purchase_id = null) surface as single-line groups — back-compat.
 *
 * Actions:
 *   - "Pagar factura": opens InvoicePaymentModal (pays all open lines of the
 *     invoice as one unit via recordInvoicePaymentAction).
 *   - "Pagar" (per-line): opens PayablePaymentModal (existing granular path).
 *
 * Satisfies: REQ-6.1–REQ-6.6, SC-5.1–SC-5.5, SC-6.4, D3 (grouped view).
 */
export function PayablesClient(props: {
  /** Grouped invoice view (from listOpenInvoicesAction). */
  invoices: OpenInvoiceGroup[];
  /** Flat payable list (from listOpenPayablesAction) — for per-line "Pagar". */
  payables: OpenPayable[];
  accounts: PaymentContainer[];
}) {
  const router = useRouter();
  const [payingInvoice, setPayingInvoice] = useState<OpenInvoiceGroup | null>(null);
  const [payingPayableId, setPayingPayableId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const payableForModal = props.payables.find(p => p.id === payingPayableId) ?? null;

  function handleSuccess() {
    setPayingInvoice(null);
    setPayingPayableId(null);
    startTransition(() => {
      router.refresh();
    });
  }

  if (props.invoices.length === 0) {
    return (
      <div className="
        flex flex-col items-center justify-center rounded-xl border
        border-dashed border-border bg-card px-6 py-16 text-center
      "
      >
        <div className="text-5xl">&#x2705;</div>
        <div className="mt-4 text-lg font-semibold">
          Sin compras pendientes de pago
        </div>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Todas las compras están pagadas o no hay compras registradas.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Proveedor</th>
              <th className="px-3 py-2">Factura</th>
              <th className="px-3 py-2">Líneas</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Pendiente</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {props.invoices.map((inv, i) => {
              // Row key: purchaseId for invoiced, payable id for standalone.
              // For standalone (purchaseId=null) we use the payable from the flat list.
              const rowKey = inv.purchaseId ?? `standalone-${i}`;
              const isInvoice = inv.purchaseId !== null;

              // For standalone groups, find the matching payable for per-line pay.
              const standalonePayable = !isInvoice
                ? props.payables.find(p => p.supplierId === inv.supplierId && !p.purchaseId)
                : null;

              return (
                <tr
                  key={rowKey}
                  className="
                    border-t transition-colors
                    hover:bg-muted/30
                  "
                >
                  <td className="px-3 py-2 font-medium">
                    {inv.supplierName ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {inv.invoiceNumber ?? (isInvoice ? '(sin número)' : '—')}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{inv.lineCount}</td>
                  <td className="px-3 py-2 tabular-nums">{money(inv.totalAmount)}</td>
                  <td className="px-3 py-2 font-semibold tabular-nums">
                    {money(inv.outstanding)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="px-3 py-2">{formatDate(inv.purchasedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {isInvoice
                      ? (
                          <Button
                            size="sm"
                            onClick={() => setPayingInvoice(inv)}
                          >
                            Pagar factura
                          </Button>
                        )
                      : standalonePayable
                        ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setPayingPayableId(standalonePayable.id)}
                            >
                              Pagar
                            </Button>
                          )
                        : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {payingInvoice && (
        <InvoicePaymentModal
          invoice={payingInvoice}
          accounts={props.accounts}
          onSuccess={handleSuccess}
          onClose={() => setPayingInvoice(null)}
        />
      )}

      {payableForModal && (
        <PayablePaymentModal
          payable={payableForModal}
          accounts={props.accounts}
          onSuccess={handleSuccess}
          onClose={() => setPayingPayableId(null)}
        />
      )}
    </div>
  );
}
