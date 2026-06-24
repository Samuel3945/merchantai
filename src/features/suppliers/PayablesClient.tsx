'use client';

import type { OpenPayable } from './actions';
import type { PaymentContainer } from '@/actions/inventory';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
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
 * Client component for the "Compras por pagar" list view.
 *
 * Renders open/partial payables; opens PayablePaymentModal on "Pagar".
 * On modal success, calls router.refresh() to re-fetch the list from the server.
 *
 * Satisfies: REQ-6.1–REQ-6.6, SC-5.1–SC-5.5, SC-6.4.
 */
export function PayablesClient(props: {
  initial: OpenPayable[];
  accounts: PaymentContainer[];
}) {
  const router = useRouter();
  const [payingId, setPayingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const payable = props.initial.find(p => p.id === payingId) ?? null;

  function handleSuccess() {
    setPayingId(null);
    startTransition(() => {
      router.refresh();
    });
  }

  if (props.initial.length === 0) {
    return (
      <div className="
        flex flex-col items-center justify-center rounded-xl border
        border-dashed border-border bg-card px-6 py-16 text-center
      "
      >
        <div className="text-5xl">✅</div>
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
              <th className="px-3 py-2">Producto</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Pagado</th>
              <th className="px-3 py-2">Pendiente</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {props.initial.map(p => (
              <tr
                key={p.id}
                className="
                  border-t transition-colors
                  hover:bg-muted/30
                "
              >
                <td className="px-3 py-2 font-medium">
                  {p.supplierName ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2">
                  {p.productName ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{money(p.totalAmount)}</td>
                <td className="px-3 py-2 tabular-nums">{money(p.paidAmount)}</td>
                <td className="px-3 py-2 font-semibold tabular-nums">
                  {money(p.outstanding)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-3 py-2">{formatDate(p.purchasedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPayingId(p.id)}
                  >
                    Pagar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {payable && (
        <PayablePaymentModal
          payable={payable}
          accounts={props.accounts}
          onSuccess={handleSuccess}
          onClose={() => setPayingId(null)}
        />
      )}
    </div>
  );
}
