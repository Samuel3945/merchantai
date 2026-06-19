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
import { useMemo, useRef, useState, useTransition } from 'react';
import {
  confirmAllPendingTransfers,
  confirmLateTransfer,
  confirmTransfer,
  correctConfirmedTransfer,
  partialTransferArrival,
  recordTransferExplanation,
  recordTransferNovelty,
  recoverTransfer,
  resolveTransfer,
} from '@/actions/transfer-reconciliation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  resolved: {
    label: 'Resuelto',
    badge: 'bg-muted/20 text-muted-foreground',
    dot: 'bg-muted-foreground',
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

// ── FIADO Customer Capture Modal ─────────────────────────────────────────────

type FiadoModalState = {
  rowId: string;
  expectedAmount: string;
};

type FiadoModalProps = {
  state: FiadoModalState | null;
  pending: boolean;
  onConfirm: (rowId: string, customerName: string, whatsapp: string, documentId: string) => void;
  onClose: () => void;
};

function FiadoModal({ state, pending, onConfirm, onClose }: FiadoModalProps) {
  const [customerName, setCustomerName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [documentId, setDocumentId] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  const hasContact = whatsapp.trim() !== '' || documentId.trim() !== '';
  const canSubmit = customerName.trim() !== '' && !pending;

  function handleOpenChange(open: boolean) {
    if (!open) {
      onClose();
      setCustomerName('');
      setWhatsapp('');
      setDocumentId('');
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[440px]"
        onOpenAutoFocus={() => nameRef.current?.focus()}
        aria-describedby="fiado-dialog-description"
      >
        <DialogHeader>
          <DialogTitle>Cobrar como fiado</DialogTitle>
          <DialogDescription id="fiado-dialog-description">
            Registrá quién asume la deuda para que el agente pueda cobrarla
            después.
            {state && (
              <span className="ml-1 font-semibold text-foreground">
                {money(state.expectedAmount)}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Customer name — required */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="fiado-customer-name"
              className="text-xs font-semibold"
            >
              Nombre completo
              {' '}
              <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              id="fiado-customer-name"
              ref={nameRef}
              className={cashInputCls}
              placeholder="Ej: Ana García"
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              autoComplete="name"
            />
          </div>

          {/* WhatsApp — recommended */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="fiado-whatsapp"
              className="text-xs font-semibold"
            >
              WhatsApp
            </label>
            <input
              id="fiado-whatsapp"
              className={cashInputCls}
              type="tel"
              inputMode="tel"
              placeholder="Ej: 3001234567"
              value={whatsapp}
              onChange={e => setWhatsapp(e.target.value)}
              autoComplete="tel"
            />
          </div>

          {/* Document ID — recommended */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="fiado-document"
              className="text-xs font-semibold"
            >
              Documento (CC / NIT)
            </label>
            <input
              id="fiado-document"
              className={cashInputCls}
              placeholder="Ej: 1234567890"
              value={documentId}
              onChange={e => setDocumentId(e.target.value)}
            />
          </div>

          {!hasContact && customerName.trim() !== '' && (
            <p className="text-xs text-warn">
              Te recomendamos al menos un contacto (WhatsApp o documento) para
              que el agente pueda cobrar el fiado.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              if (state) {
                onConfirm(state.rowId, customerName.trim(), whatsapp.trim(), documentId.trim());
              }
            }}
          >
            Registrar fiado
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Recovery Modal ───────────────────────────────────────────────────────────

type RecoveryModalState = {
  rowId: string;
  expectedAmount: string;
};

type RecoveryModalProps = {
  state: RecoveryModalState | null;
  pending: boolean;
  onConfirm: (rowId: string, arrivedAmount: number) => void;
  onClose: () => void;
};

function RecoveryModal({ state, pending, onConfirm, onClose }: RecoveryModalProps) {
  const [amount, setAmount] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  const arrivedNum = Number.parseFloat(amount);
  const canSubmit = !pending && Number.isFinite(arrivedNum) && arrivedNum > 0 && amount !== '';

  function handleOpenChange(open: boolean) {
    if (!open) {
      onClose();
      setAmount('');
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[400px]"
        onOpenAutoFocus={() => amountRef.current?.focus()}
        aria-describedby="recovery-dialog-description"
      >
        <DialogHeader>
          <DialogTitle>Registrar recuperación</DialogTitle>
          <DialogDescription id="recovery-dialog-description">
            El dinero volvió después de haberse marcado como pérdida. Indicá el
            monto que realmente llegó.
            {state && (
              <span className="ml-1 font-semibold text-foreground">
                Esperado originalmente:
                {' '}
                {money(state.expectedAmount)}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="recovery-amount" className="text-xs font-semibold">
            Monto recuperado
          </label>
          <input
            id="recovery-amount"
            ref={amountRef}
            className={cashInputCls}
            type="number"
            inputMode="decimal"
            min="0.01"
            placeholder="0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              if (state) {
                onConfirm(state.rowId, arrivedNum);
              }
            }}
          >
            Confirmar recuperación
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  history: TransferReconciliation[]; // confirmed + mismatch + resolved
  pendingCount: number;
  counts: { pending: number; confirmedToday: number; notArrived: number };
  /** Whether the current user is org:admin. Controls admin-only action buttons. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pending-row inline editor — the "Novedad" amount capture.
  const [noveltyId, setNoveltyId] = useState<string | null>(null);
  const [noveltyAmount, setNoveltyAmount] = useState('');

  // Confirmed-history inline editor (the "edit a confirmed transfer" feature).
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');

  // Investigation inline editors.
  const [explainId, setExplainId] = useState<string | null>(null);
  const [explainText, setExplainText] = useState('');

  // Arrival inline editors for not_arrived rows.
  const [partialId, setPartialId] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState('');

  // FIADO capture modal state.
  const [fiadoModal, setFiadoModal] = useState<{ rowId: string; expectedAmount: string } | null>(null);

  // Recovery modal state (admin only).
  const [recoveryModal, setRecoveryModal] = useState<{ rowId: string; expectedAmount: string } | null>(null);

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

  function handleFiadoConfirm(
    rowId: string,
    customerName: string,
    whatsapp: string,
    documentId: string,
  ) {
    run(
      () =>
        resolveTransfer(rowId, 'receivable', {
          customerName,
          whatsapp: whatsapp || null,
          documentId: documentId || null,
        }),
      () => setFiadoModal(null),
    );
  }

  function handleRecoveryConfirm(rowId: string, arrivedAmount: number) {
    run(
      () => recoverTransfer(rowId, arrivedAmount),
      () => setRecoveryModal(null),
    );
  }

  // History rows: confirmed + mismatch (editable). Resolved rows are separate.
  const editableHistory = useMemo(
    () => props.history.filter(r => r.status === 'confirmed' || r.status === 'mismatch'),
    [props.history],
  );

  // Resolved-as-loss rows that the admin can potentially recover.
  const resolvedLossRows = useMemo(
    () => props.history.filter(r => r.status === 'resolved' && r.resolutionType === 'loss'),
    [props.history],
  );

  const allRows = useMemo(
    () => [...props.reconciliations, ...editableHistory],
    [props.reconciliations, editableHistory],
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
      label: `Confirmadas · ${editableHistory.length}`,
    },
    {
      k: 'pending',
      label: `Por verificar · ${props.reconciliations.length}`,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Modals */}
      {/* key per row so the modal remounts with fresh inputs every open —
          prevents the previous customer's data leaking into the next fiado. */}
      <FiadoModal
        key={fiadoModal?.rowId ?? 'fiado-closed'}
        state={fiadoModal}
        pending={pending}
        onConfirm={handleFiadoConfirm}
        onClose={() => setFiadoModal(null)}
      />
      <RecoveryModal
        key={recoveryModal?.rowId ?? 'recovery-closed'}
        state={recoveryModal}
        pending={pending}
        onConfirm={handleRecoveryConfirm}
        onClose={() => setRecoveryModal(null)}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold">
            ¿Las transferencias cuadran?
          </h2>
          <p className="text-sm text-muted-foreground">
            El cajero marca cada transferencia que entra. Acá verificás que todo
            aparezca.
          </p>
        </div>
        {props.pendingCount > 0 && (
          <Button
            disabled={pending}
            onClick={() => run(() => confirmAllPendingTransfers())}
          >
            Confirmar todo (
            {props.pendingCount}
            )
          </Button>
        )}
      </div>

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
                                  setNoveltyId(noveltyId === r.id ? null : r.id);
                                  setNoveltyAmount('');
                                }}
                              >
                                Novedad
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

                      {isPending && noveltyId === r.id && (
                        <div className="
                          mt-3 space-y-2 rounded-lg border border-border
                          bg-background p-3
                        "
                        >
                          <div className="text-xs text-muted-foreground">
                            Ingresá cuánto llegó realmente. Si llegó de más, se
                            confirma igual. Si llegó de menos (o nada), el
                            faltante va a investigación o pérdida según Ajustes de
                            transferencias.
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              aria-label="Monto que llegó realmente"
                              className={cn(cashInputCls, 'max-w-40')}
                              type="number"
                              inputMode="decimal"
                              min="0"
                              placeholder="Monto que llegó"
                              value={noveltyAmount}
                              onChange={e => setNoveltyAmount(e.target.value)}
                            />
                            <Button
                              size="sm"
                              disabled={pending || noveltyAmount === ''}
                              onClick={() =>
                                run(
                                  () => recordTransferNovelty(r.id, noveltyAmount),
                                  () => {
                                    setNoveltyId(null);
                                    setNoveltyAmount('');
                                  },
                                )}
                            >
                              Guardar novedad
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => setNoveltyId(null)}
                            >
                              Cancelar
                            </Button>
                          </div>
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

                  {/* Resolution action buttons */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Axis-1: late full arrival — cashier-level */}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run(() => confirmLateTransfer(r.id))}
                    >
                      Llegó tarde (completa)
                    </Button>

                    {/* Axis-1: partial arrival — cashier-level (toggles inline input) */}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setPartialId(partialId === r.id ? null : r.id);
                        setPartialAmount('');
                      }}
                    >
                      Llegó parcial
                    </Button>

                    {/* Axis-2: FIADO — cashier-level, opens capture modal */}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setFiadoModal({ rowId: r.id, expectedAmount: r.expectedAmount })}
                    >
                      Cobrar (fiado)
                    </Button>

                    {/* Axis-2: admin-only outcome — PÉRDIDA (with/without claim) */}
                    {props.isAdmin && (
                      <LossDropdown
                        disabled={pending}
                        onLoss={() => run(() => resolveTransfer(r.id, 'loss', undefined, false))}
                        onLossWithClaim={() =>
                          run(() => resolveTransfer(r.id, 'loss', undefined, true))}
                      />
                    )}
                  </div>
                </div>

                {/* Partial arrival inline input */}
                {partialId === r.id && (
                  <div className="
                    mt-3 space-y-2 rounded-lg border border-border bg-background
                    p-3
                  "
                  >
                    <div className="text-xs text-muted-foreground">
                      Ingresá el monto que sí llegó. Se crea un nuevo registro
                      por la diferencia.
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label="Monto que llegó parcialmente"
                        className={cn(cashInputCls, 'max-w-40')}
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        placeholder="Monto que llegó"
                        value={partialAmount}
                        onChange={e => setPartialAmount(e.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={pending || partialAmount === ''}
                        onClick={() =>
                          run(
                            () => partialTransferArrival(r.id, partialAmount),
                            () => {
                              setPartialId(null);
                              setPartialAmount('');
                            },
                          )}
                      >
                        Confirmar parcial
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setPartialId(null)}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}

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
        </div>
      )}

      {/* Resolved-as-loss rows — admin-only recovery surface */}
      {props.isAdmin && resolvedLossRows.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="font-display text-lg font-semibold">
              Pérdidas registradas
            </h3>
            <p className="text-sm text-muted-foreground">
              Si el dinero apareció después, podés registrar una recuperación
              para que entre a Tesorería.
            </p>
          </div>
          <div className="space-y-2">
            {resolvedLossRows.map(r => (
              <Card key={r.id} className="p-4">
                <div className="
                  flex flex-wrap items-center justify-between gap-3
                "
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="
                      flex size-9 shrink-0 items-center justify-center
                      rounded-lg bg-muted text-muted-foreground
                    "
                    >
                      <Send className="size-4" />
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
                        {r.claimOpen && (
                          <span className="
                            inline-flex h-6 items-center rounded-full bg-warn/10
                            px-2.5 text-xs font-semibold text-warn
                          "
                          >
                            Con reclamo abierto
                          </span>
                        )}
                      </div>
                      <RowMeta row={r} />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      setRecoveryModal({
                        rowId: r.id,
                        expectedAmount: r.expectedAmount,
                      })}
                  >
                    Recuperar
                  </Button>
                </div>
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

// ── LossDropdown ─────────────────────────────────────────────────────────────
// Inline component for the two PÉRDIDA variants. Uses a simple toggle approach
// rather than a Radix dropdown to stay consistent with the panel's existing
// inline-editor pattern.

type LossDropdownProps = {
  disabled: boolean;
  onLoss: () => void;
  onLossWithClaim: () => void;
};

function LossDropdown({ disabled, onLoss, onLossWithClaim }: LossDropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Pérdida
      </Button>
      {open && (
        <div
          role="menu"
          className="
            absolute top-full right-0 z-10 mt-1 min-w-[180px] rounded-lg border
            border-border bg-card py-1 shadow-md
          "
        >
          <button
            role="menuitem"
            type="button"
            className="
              w-full px-3 py-2 text-left text-sm
              hover:bg-muted
              focus:bg-muted
            "
            onClick={() => {
              setOpen(false);
              onLoss();
            }}
          >
            Sin reclamo
          </button>
          <button
            role="menuitem"
            type="button"
            className="
              w-full px-3 py-2 text-left text-sm
              hover:bg-muted
              focus:bg-muted
            "
            onClick={() => {
              setOpen(false);
              onLossWithClaim();
            }}
          >
            Con reclamo / denuncia
          </button>
        </div>
      )}
    </div>
  );
}
