'use client';

import type { AccountCuadre, TransferCuadreOverview } from '@/actions/transfer-reconciliation';
import type { ActionResult } from '@/libs/action-result';
import type {
  ReconciliationStatus,
  TransferReconciliation,
} from '@/libs/transfer-reconciliation';
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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

// ── Compact pending row (per-account disclosure + "sin cuenta asignada") ────
// Same Confirmar/Novedad flow as the pending rows in the main list below,
// extracted so the cuadre-per-account disclosure and the unresolved-methods
// group can reuse it without duplicating the shared novelty-editor state.
type PendingRowCompactProps = {
  row: TransferReconciliation;
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, onSuccess?: () => void) => void;
  noveltyId: string | null;
  noveltyStage: 'choice' | 'partial';
  noveltyAmount: string;
  onStartNovelty: (id: string) => void;
  onNoveltyStageChange: (stage: 'choice' | 'partial') => void;
  onNoveltyAmountChange: (value: string) => void;
  onCloseNovelty: () => void;
};

function PendingRowCompact({
  row: r,
  pending,
  run,
  noveltyId,
  noveltyStage,
  noveltyAmount,
  onStartNovelty,
  onNoveltyStageChange,
  onNoveltyAmountChange,
  onCloseNovelty,
}: PendingRowCompactProps) {
  const isOpen = noveltyId === r.id;
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="
            flex size-9 shrink-0 items-center justify-center rounded-lg
            bg-secondary text-muted-foreground
          "
          >
            <Send className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{r.method}</span>
              <span className="font-display tabular-nums">
                {money(r.expectedAmount)}
              </span>
            </div>
            <RowMeta row={r} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StateBadge status={r.status} />
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
            onClick={() => onStartNovelty(r.id)}
          >
            Novedad
          </Button>
        </div>
      </div>

      {isOpen && (
        <div className="
          mt-3 space-y-2 rounded-lg border border-border bg-background p-3
        "
        >
          {noveltyStage === 'choice'
            ? (
                <>
                  <div className="text-xs text-muted-foreground">
                    ¿Qué pasó con esta transferencia? Elegí si llegó incompleta
                    o si no llegó nada.
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => onNoveltyStageChange('partial')}
                    >
                      Llegó incompleta
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() =>
                        run(() => recordTransferNovelty(r.id, 0), onCloseNovelty)}
                    >
                      No llegó
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={onCloseNovelty}
                    >
                      Cancelar
                    </Button>
                  </div>
                </>
              )
            : (
                <>
                  <div className="text-xs text-muted-foreground">
                    Ingresá el monto que sí llegó. El faltante va a
                    investigación o pérdida según Ajustes de transferencias.
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
                      onChange={e => onNoveltyAmountChange(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={pending || noveltyAmount === ''}
                      onClick={() =>
                        run(
                          () => recordTransferNovelty(r.id, noveltyAmount),
                          onCloseNovelty,
                        )}
                    >
                      Guardar novedad
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => onNoveltyStageChange('choice')}
                    >
                      Volver
                    </Button>
                  </div>
                </>
              )}
        </div>
      )}
    </li>
  );
}

// ── Cuadre-per-account card ──────────────────────────────────────────────────
// The core of the redesign: instead of reviewing every pending transfer one by
// one, the owner compares ONE number — "en tu banco deberías tener" — against
// their banking app. Matches → one click confirms every pending transfer for
// this account. Doesn't match → the disclosure below still lets them review
// the pending rows for JUST this account, one by one.
function AccountCuadreCard(props: {
  account: AccountCuadre;
  pending: boolean;
  onConfirmAll: (accountId: string) => void;
  reviewOpen: boolean;
  onToggleReview: () => void;
  children?: React.ReactNode;
}) {
  const { account } = props;
  const allClear = account.pendingCount === 0;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="
        text-xs font-semibold tracking-wide text-muted-foreground uppercase
      "
      >
        {account.accountName}
      </div>

      <div>
        <div className="text-sm text-muted-foreground">
          En tu banco deberías tener
        </div>
        <div className="font-display text-3xl font-semibold tabular-nums">
          {money(account.expectedTotal)}
        </div>
      </div>

      {allClear
        ? (
            <div className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 className="size-4" />
              Todo cuadra
            </div>
          )
        : (
            <>
              <div className="text-xs text-muted-foreground">
                {money(account.confirmedBalance)}
                {' '}
                confirmado +
                {' '}
                {money(account.pendingTotal)}
                {' '}
                sin confirmar (
                {account.pendingCount}
                )
              </div>
              <Button
                size="sm"
                disabled={props.pending}
                onClick={() => props.onConfirmAll(account.accountId)}
              >
                <CheckCircle2 className="size-3.5" />
                {`Coincide con mi banco → Confirmar las ${account.pendingCount}`}
              </Button>
              <button
                type="button"
                aria-expanded={props.reviewOpen}
                onClick={props.onToggleReview}
                className="
                  inline-flex items-center gap-1 self-start text-xs
                  font-semibold text-muted-foreground
                  hover:text-foreground
                "
              >
                ¿No coincide? Revisar una por una
                {props.reviewOpen
                  ? <ChevronUp className="size-3.5" />
                  : <ChevronDown className="size-3.5" />}
              </button>
              {props.reviewOpen && (
                <ul className="
                  -mx-5 mt-1 -mb-5 divide-y divide-border border-t border-border
                "
                >
                  {props.children}
                </ul>
              )}
            </>
          )}
    </Card>
  );
}

// ── CREDITO Customer Capture Modal ─────────────────────────────────────────────

type CreditoModalState = {
  rowId: string;
  expectedAmount: string;
};

type CreditoModalProps = {
  state: CreditoModalState | null;
  pending: boolean;
  onConfirm: (rowId: string, customerName: string, whatsapp: string, documentId: string) => void;
  onClose: () => void;
};

function CreditoModal({ state, pending, onConfirm, onClose }: CreditoModalProps) {
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
        aria-describedby="credito-dialog-description"
      >
        <DialogHeader>
          <DialogTitle>Cobrar como crédito</DialogTitle>
          <DialogDescription id="credito-dialog-description">
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
              htmlFor="credito-customer-name"
              className="text-xs font-semibold"
            >
              Nombre completo
              {' '}
              <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              id="credito-customer-name"
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
              htmlFor="credito-whatsapp"
              className="text-xs font-semibold"
            >
              WhatsApp
            </label>
            <input
              id="credito-whatsapp"
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
              htmlFor="credito-document"
              className="text-xs font-semibold"
            >
              Documento (CC / NIT)
            </label>
            <input
              id="credito-document"
              className={cashInputCls}
              placeholder="Ej: 1234567890"
              value={documentId}
              onChange={e => setDocumentId(e.target.value)}
            />
          </div>

          {!hasContact && customerName.trim() !== '' && (
            <p className="text-xs text-warn">
              Te recomendamos al menos un contacto (WhatsApp o documento) para
              que el agente pueda cobrar el crédito.
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
            Registrar crédito
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

// Pending transfers no longer appear in this flat list — each one lives under
// its account's "¿No coincide? Revisar una por una" disclosure (or the "Sin
// cuenta asignada" bucket). This list is now the verified/closed history only.
type Chip = 'all' | 'confirmed' | 'loss';

function rowMatchesChip(row: TransferReconciliation, chip: Chip): boolean {
  if (chip === 'all') {
    return true;
  }
  if (chip === 'loss') {
    return row.status === 'resolved' && row.resolutionType === 'loss';
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
  // Only `notArrived` survives the StatCard removal — it drives the demoted
  // "No llegó" alert. The pending/confirmedToday counters are no longer shown.
  counts: { notArrived: number };
  /**
   * Per-banco-account cuadre: confirmed balance + pending unconfirmed, and the
   * unresolved (no single account) bucket. Drives the redesigned top section.
   */
  cuadre: TransferCuadreOverview;
  /** Whether the current user is org:admin. Controls admin-only action buttons. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pending-row "Novedad" flow. First a choice (arrived incomplete vs. never
  // arrived), then — only for the incomplete path — the amount that did arrive.
  // Typing 0 to mean "didn't arrive" was confusing, so it's an explicit button.
  const [noveltyId, setNoveltyId] = useState<string | null>(null);
  const [noveltyStage, setNoveltyStage] = useState<'choice' | 'partial'>('choice');
  const [noveltyAmount, setNoveltyAmount] = useState('');

  // Confirmed-history inline editor — the only correction is reversing a
  // confirmed transfer that never actually arrived. The amount is immutable.
  const [editId, setEditId] = useState<string | null>(null);

  // Arrival inline editors for not_arrived rows.
  const [partialId, setPartialId] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState('');

  // CREDITO capture modal state.
  const [creditoModal, setCreditoModal] = useState<{ rowId: string; expectedAmount: string } | null>(null);

  // Recovery modal state (admin only).
  const [recoveryModal, setRecoveryModal] = useState<{ rowId: string; expectedAmount: string } | null>(null);

  // Filters / sort (display only — never mutate, just locate).
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sortDesc, setSortDesc] = useState(true);

  // Cuadre-per-account: which account's "revisar una por una" disclosure is
  // open (one at a time — mirrors the single-active-row pattern below).
  const [reviewOpenAccountId, setReviewOpenAccountId] = useState<string | null>(null);

  // Scroll target for the demoted "No llegó" alert's "Resolver" action — jumps
  // to the full "En investigación" block already rendered above instead of
  // duplicating its content.
  const investigacionRef = useRef<HTMLDivElement>(null);

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

  // Opens the novelty editor for a row (or closes it if already open),
  // resetting its stage/amount — shared by the bottom list and every
  // PendingRowCompact usage (cuadre disclosure + "sin cuenta asignada").
  function startNovelty(id: string) {
    setNoveltyId(noveltyId === id ? null : id);
    setNoveltyStage('choice');
    setNoveltyAmount('');
  }

  function closeNovelty() {
    setNoveltyId(null);
    setNoveltyStage('choice');
    setNoveltyAmount('');
  }

  // Pending rows grouped by lowercased method — lets the cuadre cards and the
  // "sin cuenta asignada" group filter down to just the rows for their
  // account's methods, without a second server round-trip.
  const pendingRowsByMethod = useMemo(() => {
    const map = new Map<string, TransferReconciliation[]>();
    for (const r of props.reconciliations) {
      const key = r.method.toLowerCase();
      const list = map.get(key);
      if (list) {
        list.push(r);
      } else {
        map.set(key, [r]);
      }
    }
    return map;
  }, [props.reconciliations]);

  // De-dupes by lowercased key first — two differently-cased method strings
  // that resolve to the same account (e.g. "Nequi" and "NEQUI") must not cause
  // the same underlying rows to be pushed twice.
  function rowsForMethods(methods: string[]): TransferReconciliation[] {
    const keys = new Set(methods.map(m => m.toLowerCase()));
    const rows: TransferReconciliation[] = [];
    for (const key of keys) {
      const list = pendingRowsByMethod.get(key);
      if (list) {
        rows.push(...list);
      }
    }
    return rows;
  }

  const unresolvedRows = useMemo(
    () => rowsForMethods(props.cuadre.unresolved.methods.map(m => m.method)),
    // eslint-disable-next-line react/exhaustive-deps -- rowsForMethods reads pendingRowsByMethod, already a dep
    [pendingRowsByMethod, props.cuadre.unresolved.methods],
  );

  function handleCreditoConfirm(
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
      () => setCreditoModal(null),
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

  // The flat list is history only — pending rows are reviewed per account
  // above (cuadre disclosures + "Sin cuenta asignada"), never duplicated here.
  const allRows = useMemo(
    () => [...editableHistory, ...resolvedLossRows],
    [editableHistory, resolvedLossRows],
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
    ...(props.isAdmin
      ? [{ k: 'loss' as const, label: `Pérdidas · ${resolvedLossRows.length}` }]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Modals */}
      {/* key per row so the modal remounts with fresh inputs every open —
          prevents the previous customer's data leaking into the next credito. */}
      <CreditoModal
        key={creditoModal?.rowId ?? 'credito-closed'}
        state={creditoModal}
        pending={pending}
        onConfirm={handleCreditoConfirm}
        onClose={() => setCreditoModal(null)}
      />
      <RecoveryModal
        key={recoveryModal?.rowId ?? 'recovery-closed'}
        state={recoveryModal}
        pending={pending}
        onConfirm={handleRecoveryConfirm}
        onClose={() => setRecoveryModal(null)}
      />

      {/* En investigación — surfaced at the top: it's the urgent money that
          didn't arrive, so it sits right under "¿Cuánta plata entró hoy?" and
          above the full reconciliation list. */}
      {props.investigating.length > 0 && (
        <div ref={investigacionRef} className="space-y-3">
          <div>
            <h3 className="font-display text-lg font-semibold">
              En investigación
            </h3>
            <p className="text-sm text-muted-foreground">
              No aparecieron en la cuenta. Hay que resolver qué pasó con cada
              una: o se recupera o es pérdida.
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
                          Sin resolver
                        </span>
                      </div>
                      <RowMeta row={r} />
                    </div>
                  </div>

                  {/* Two realities for a transfer that didn't arrive: the money
                      is recovered (Solución) or it's gone (Pérdida). */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Solución groups the three recovery paths — all cashier-level */}
                    <SolutionDropdown
                      disabled={pending}
                      onArrivedFull={() => run(() => confirmLateTransfer(r.id))}
                      onArrivedPartial={() => {
                        setPartialId(partialId === r.id ? null : r.id);
                        setPartialAmount('');
                      }}
                      onCredito={() =>
                        setCreditoModal({ rowId: r.id, expectedAmount: r.expectedAmount })}
                    />

                    {/* PÉRDIDA — admin-only. Loss is loss: no claim distinction.
                        If the money shows up later it can still be recovered. */}
                    {props.isAdmin && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => run(() => resolveTransfer(r.id, 'loss'))}
                      >
                        Pérdida
                      </Button>
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

              </Card>
            ))}
          </div>
        </div>
      )}

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

      {/* Cuadre per account — the new hero metric: "en tu banco deberías
          tener" = confirmado + pendiente sin confirmar. Matches the bank app
          → one click confirms everything for that account. Doesn't match →
          the disclosure below still allows a per-row review, scoped to just
          that account. */}
      {props.cuadre.accounts.length === 0
        ? (
            <div className="
              rounded-lg border border-dashed border-border p-4 text-sm
              text-muted-foreground
            "
            >
              Todavía no tenés una cuenta bancaria configurada para
              transferencias. Configurala en Tesorería para ver acá cuánto
              deberías tener en cada banco.
            </div>
          )
        : (
            <div className="
              grid grid-cols-1 gap-3
              sm:grid-cols-2
              lg:grid-cols-3
            "
            >
              {props.cuadre.accounts.map((account) => {
                const accountRows = rowsForMethods(account.methods);
                return (
                  <AccountCuadreCard
                    key={account.accountId}
                    account={account}
                    pending={pending}
                    onConfirmAll={accountId =>
                      run(() => confirmAllPendingTransfers({ accountId }))}
                    reviewOpen={reviewOpenAccountId === account.accountId}
                    onToggleReview={() =>
                      setReviewOpenAccountId(
                        reviewOpenAccountId === account.accountId
                          ? null
                          : account.accountId,
                      )}
                  >
                    {accountRows.map(r => (
                      <PendingRowCompact
                        key={r.id}
                        row={r}
                        pending={pending}
                        run={run}
                        noveltyId={noveltyId}
                        noveltyStage={noveltyStage}
                        noveltyAmount={noveltyAmount}
                        onStartNovelty={startNovelty}
                        onNoveltyStageChange={setNoveltyStage}
                        onNoveltyAmountChange={setNoveltyAmount}
                        onCloseNovelty={closeNovelty}
                      />
                    ))}
                  </AccountCuadreCard>
                );
              })}
            </div>
          )}

      {/* Sin cuenta asignada — the method didn't resolve to exactly one bank
          account (none, or more than one), so it can't be attributed to a
          cuadre card above. The money stays visible here instead of vanishing. */}
      {unresolvedRows.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border p-4">
            <div className="text-sm font-semibold">Sin cuenta asignada</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Estas transferencias no están linkeadas a una única cuenta
              bancaria (el método de pago no apunta a ningún banco, o apunta a
              más de uno). La plata sigue acá — revisala una por una.
            </p>
          </div>
          <ul className="divide-y divide-border">
            {unresolvedRows.map(r => (
              <PendingRowCompact
                key={r.id}
                row={r}
                pending={pending}
                run={run}
                noveltyId={noveltyId}
                noveltyStage={noveltyStage}
                noveltyAmount={noveltyAmount}
                onStartNovelty={startNovelty}
                onNoveltyStageChange={setNoveltyStage}
                onNoveltyAmountChange={setNoveltyAmount}
                onCloseNovelty={closeNovelty}
              />
            ))}
          </ul>
        </Card>
      )}

      {/* "No llegó" — demoted from a peer KPI tile to a status alert: it's not
          just a count, it's money that needs an owner decision. "Resolver"
          jumps to the full investigation list already rendered above (never
          duplicated here). */}
      {props.counts.notArrived > 0 && (
        <div className="
          flex flex-wrap items-center gap-3 rounded-lg border
          border-destructive/30 bg-destructive/5 px-4 py-3 text-sm
          text-destructive
        "
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">
            {props.counts.notArrived === 1
              ? '1 transferencia no llegó'
              : `${props.counts.notArrived} transferencias no llegaron`}
            {' '}
            — hay que averiguar qué pasó.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              investigacionRef.current?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
              })}
          >
            Resolver
          </Button>
        </div>
      )}

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
              <ul className="
                scrollbar-subtle max-h-112 scrollbar-gutter-stable divide-y
                divide-border overflow-y-auto
              "
              >
                {shown.map((r) => {
                  const isConfirmed
                    = r.status === 'confirmed' || r.status === 'mismatch';
                  const isLoss
                    = r.status === 'resolved' && r.resolutionType === 'loss';
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
                          {isLoss
                            ? (
                                <span className="
                                  inline-flex h-7 items-center rounded-full
                                  bg-destructive/10 px-3 text-xs font-semibold
                                  text-destructive
                                "
                                >
                                  Pérdida
                                </span>
                              )
                            : <StateBadge status={r.status} />}
                          {isConfirmed && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() =>
                                setEditId(editId === r.id ? null : r.id)}
                            >
                              <Pencil className="size-3.5" />
                              Corregir
                            </Button>
                          )}
                          {isLoss && props.isAdmin && (
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
                          )}
                        </div>
                      </div>

                      {isConfirmed && editId === r.id && (
                        <div className="
                          mt-3 space-y-2 rounded-lg border border-border
                          bg-background p-3
                        "
                        >
                          <div className="text-xs text-muted-foreground">
                            El monto de una transferencia confirmada no se
                            cambia: lo que llegó es lo que debió llegar. Si en
                            realidad nunca llegó, revertila acá y Tesorería se
                            ajusta sola.
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={pending}
                              onClick={() =>
                                run(
                                  () => correctConfirmedTransfer(r.id),
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

// ── SolutionDropdown ─────────────────────────────────────────────────────────
// Groups the three recovery paths for a transfer under investigation under one
// "Solución" action: it arrived in full, it arrived partially, or it becomes a
// credito someone will pay. All cashier-level. Mirrors LossDropdown's inline menu.

type SolutionDropdownProps = {
  disabled: boolean;
  onArrivedFull: () => void;
  onArrivedPartial: () => void;
  onCredito: () => void;
};

function SolutionDropdown({
  disabled,
  onArrivedFull,
  onArrivedPartial,
  onCredito,
}: SolutionDropdownProps) {
  const [open, setOpen] = useState(false);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div className="relative">
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Solución
      </Button>
      {open && (
        <div
          role="menu"
          className="
            absolute top-full right-0 z-10 mt-1 min-w-[200px] rounded-lg border
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
            onClick={() => pick(onArrivedFull)}
          >
            Llegó completa
          </button>
          <button
            role="menuitem"
            type="button"
            className="
              w-full px-3 py-2 text-left text-sm
              hover:bg-muted
              focus:bg-muted
            "
            onClick={() => pick(onArrivedPartial)}
          >
            Llegó incompleta
          </button>
          <button
            role="menuitem"
            type="button"
            className="
              w-full px-3 py-2 text-left text-sm
              hover:bg-muted
              focus:bg-muted
            "
            onClick={() => pick(onCredito)}
          >
            Queda en crédito
          </button>
        </div>
      )}
    </div>
  );
}
