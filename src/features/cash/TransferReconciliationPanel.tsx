'use client';

import type { ActionResult } from '@/libs/action-result';
import type { TransferReconciliation } from '@/libs/transfer-reconciliation';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  confirmAllPendingTransfers,
  confirmTransfer,
  markTransferMismatch,
  markTransferNotArrived,
  recordTransferExplanation,
  resolveTransfer,
} from '@/actions/transfer-reconciliation';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { cashInputCls, money, relativeTime } from './cash-ui';

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

export function TransferReconciliationPanel(props: {
  reconciliations: TransferReconciliation[];
  investigating: TransferReconciliation[];
  pendingCount: number;
  pendingTotal: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Which row is in "arrived for a different amount" edit mode, and its input.
  const [mismatchId, setMismatchId] = useState<string | null>(null);
  const [mismatchAmount, setMismatchAmount] = useState('');
  // Which investigation row is recording the cashier explanation, and its text.
  const [explainId, setExplainId] = useState<string | null>(null);
  const [explainText, setExplainText] = useState('');

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

  const rows = props.reconciliations;

  return (
    <div className="space-y-6">
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
            <div className="text-xs text-muted-foreground">Pendientes</div>
            <div className="font-display text-xl font-medium tabular-nums">
              {props.pendingCount}
              {' · '}
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

      {rows.length === 0
        ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No hay transferencias pendientes de conciliar. Todo al día.
            </Card>
          )
        : (
            <div className="space-y-2">
              {rows.map(r => (
                <Card key={r.id} className="p-4">
                  <div className="
                    flex flex-wrap items-center justify-between gap-3
                  "
                  >
                    <div className="min-w-0">
                      <div className="
                        flex items-center gap-2 text-sm font-medium
                      "
                      >
                        <span>{r.method}</span>
                        <span className="font-display tabular-nums">
                          {money(r.expectedAmount)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {r.reference ? `Ref: ${r.reference} · ` : ''}
                        {relativeTime(r.createdAt)}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
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
                        onClick={() => run(() => markTransferNotArrived(r.id))}
                      >
                        No llegó
                      </Button>
                    </div>
                  </div>

                  {mismatchId === r.id && (
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
                </Card>
              ))}
            </div>
          )}

      {props.investigating.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">
            En investigación
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              · transferencias que no llegaron · el cajero debe explicar
            </span>
          </div>
          {props.investigating.map(r => (
            <Card key={r.id} className="border-destructive/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{r.method}</span>
                    <span className="font-display tabular-nums">
                      {money(r.expectedAmount)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {r.reference ? `Ref: ${r.reference} · ` : ''}
                    {relativeTime(r.createdAt)}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(() => resolveTransfer(r.id, 'receivable'))}
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
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
