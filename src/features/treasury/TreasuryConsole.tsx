'use client';

import type { ReactNode } from 'react';
import type { PaymentMethodRow } from '@/actions/payment-methods';
import type { TreasuryAccount, TreasuryAccountRow } from '@/libs/treasury';
import { ChevronDown, Coins, Landmark, Lock, Plus, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  createBanco,
  createCajaFuerte,
  transferEntreCajas,
} from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls, money } from '@/features/cash/cash-ui';
import { Consignar } from './Consignar';

const GROUPS: { type: TreasuryAccount['type']; label: string }[] = [
  { type: 'caja', label: 'Cajas' },
  { type: 'caja_fuerte', label: 'Caja fuerte' },
  { type: 'banco', label: 'Cuentas bancarias' },
];

function sum(items: TreasuryAccount[]): number {
  return items.reduce((acc, a) => acc + a.balance, 0);
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// One compact card for the always-visible summary strip.
function SummaryCard(props: {
  icon: ReactNode;
  label: string;
  amount: number;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`
        rounded-lg border p-3
        ${
    props.highlight
      ? 'border-primary/20 bg-primary/5'
      : 'border-border bg-background'
    }
      `}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {props.icon}
        <span className="truncate">{props.label}</span>
      </div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums">
        {money(props.amount)}
      </div>
      {props.hint && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {props.hint}
        </div>
      )}
    </div>
  );
}

// ── Inline form: Agregar caja fuerte ─────────────────────────────────────────

function AgregarCajaFuerteForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const bal = Number.parseFloat(openingBalance) || 0;
    startTransition(async () => {
      try {
        const res = await createCajaFuerte(name, bal);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setName('');
        setOpeningBalance('');
        onDone();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          flex items-center gap-1 text-xs font-medium text-primary
          hover:underline
        "
      >
        <Plus className="size-3" />
        Agregar caja fuerte
      </button>
    );
  }

  return (
    <div className="
      mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3
    "
    >
      <p className="text-xs font-medium">Nueva caja fuerte</p>
      <input
        className={cashInputCls}
        placeholder="Nombre (ej: Bóveda principal)"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <input
        className={cashInputCls}
        type="number"
        inputMode="decimal"
        min="0"
        placeholder="Saldo inicial (opcional)"
        value={openingBalance}
        onChange={e => setOpeningBalance(e.target.value)}
      />
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || name.trim() === ''}
          onClick={submit}
        >
          Crear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ── Inline form: Agregar cuenta bancaria ──────────────────────────────────────

function AgregarBancoForm({
  transferMethods,
  onDone,
}: {
  transferMethods: PaymentMethodRow[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  const methodOptions = transferMethods.map(m => ({
    value: m.id,
    label: m.name,
  }));

  function submit() {
    setError(null);
    if (!paymentMethodId) {
      setError('Seleccioná un método de pago');
      return;
    }
    const bal = Number.parseFloat(openingBalance) || 0;
    startTransition(async () => {
      try {
        const res = await createBanco(name, paymentMethodId, bal);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setName('');
        setPaymentMethodId('');
        setOpeningBalance('');
        onDone();
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          flex items-center gap-1 text-xs font-medium text-primary
          hover:underline
        "
      >
        <Plus className="size-3" />
        Agregar cuenta bancaria
      </button>
    );
  }

  return (
    <div className="
      mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3
    "
    >
      <p className="text-xs font-medium">Nueva cuenta bancaria</p>
      <input
        className={cashInputCls}
        placeholder="Nombre (ej: Bancolombia ahorros)"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <Select
        value={paymentMethodId}
        onValueChange={setPaymentMethodId}
        options={methodOptions}
        placeholder="Método de pago vinculado"
      />
      <input
        className={cashInputCls}
        type="number"
        inputMode="decimal"
        min="0"
        placeholder="Saldo inicial (opcional)"
        value={openingBalance}
        onChange={e => setOpeningBalance(e.target.value)}
      />
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || name.trim() === '' || paymentMethodId === ''}
          onClick={submit}
        >
          Crear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ── Inline form: Mover plata (transferEntreCajas / consignarDesde) ────────────
// Routes:
//   caja_fuerte → banco        = consignarDesde (already in Consignar.tsx per-card)
//   caja_fuerte ↔ caja_fuerte  = transferEntreCajas
//   caja_fuerte → caja_fuerte  = transferEntreCajas
//   (caja ↔ caja is Phase 3; not offered here)

function MoverPlataForm({ accountRows }: { accountRows: TreasuryAccountRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Only offer non-caja accounts as origin/destination for explicit transfers.
  // Cajas → caja_fuerte dual-write is handled by the existing retiro_seguridad
  // path in MovementModal (not here). Phase 3 handles caja↔caja native ledger.
  const eligibleAccounts = accountRows.filter(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );

  const fromOptions = eligibleAccounts.map(a => ({
    value: a.id,
    label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
  }));

  const toOptions = eligibleAccounts
    .filter(a => a.id !== fromId)
    .map(a => ({
      value: a.id,
      label: `${a.name} (${a.type === 'caja_fuerte' ? 'caja fuerte' : 'banco'})`,
    }));

  if (eligibleAccounts.length < 2) {
    return null;
  }

  function submit() {
    setError(null);
    if (!fromId || !toId) {
      setError('Seleccioná origen y destino');
      return;
    }
    if (fromId === toId) {
      setError('El origen y el destino deben ser diferentes');
      return;
    }
    const amt = Number.parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Ingresá un monto mayor a cero');
      return;
    }

    startTransition(async () => {
      try {
        const res = await transferEntreCajas(fromId, toId, amount, reason || null);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setFromId('');
        setToId('');
        setAmount('');
        setReason('');
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          text-xs font-medium text-primary
          hover:underline
        "
      >
        Mover plata
      </button>
    );
  }

  return (
    <div className="
      mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3
    "
    >
      <p className="text-xs font-medium">Mover plata entre contenedores</p>
      <Select
        value={fromId}
        onValueChange={(v) => {
          setFromId(v);
          if (v === toId) {
            setToId('');
          }
        }}
        options={fromOptions}
        placeholder="Origen"
      />
      <Select
        value={toId}
        onValueChange={setToId}
        options={toOptions}
        placeholder="Destino"
      />
      <input
        className={cashInputCls}
        type="number"
        inputMode="decimal"
        min="0"
        placeholder="Monto"
        value={amount}
        onChange={e => setAmount(e.target.value)}
      />
      <input
        className={cashInputCls}
        placeholder="Nota (opcional)"
        value={reason}
        onChange={e => setReason(e.target.value)}
      />
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !fromId || !toId || amount === ''}
          onClick={submit}
        >
          Transferir
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyTreasuryState({
  transferMethods,
  onCreated,
}: {
  transferMethods: PaymentMethodRow[];
  onCreated: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="text-sm font-semibold">Dónde está la plata</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Todavía no hay contenedores de tesorería. Creá una caja fuerte o una
        cuenta bancaria para empezar a registrar el dinero de la empresa.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <AgregarCajaFuerteForm onDone={onCreated} />
        {transferMethods.length > 0 && (
          <AgregarBancoForm transferMethods={transferMethods} onDone={onCreated} />
        )}
      </div>
    </div>
  );
}

// ── Actions toolbar (shown in detail panel when containers exist) ──────────────

function ActionsToolbar({
  accountRows,
  transferMethods,
}: {
  accountRows: TreasuryAccountRow[];
  transferMethods: PaymentMethodRow[];
}) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        Acciones
      </div>
      <div className="flex flex-wrap gap-4">
        <AgregarCajaFuerteForm onDone={() => {}} />
        {transferMethods.length > 0 && (
          <AgregarBancoForm transferMethods={transferMethods} onDone={() => {}} />
        )}
        <MoverPlataForm accountRows={accountRows} />
      </div>
    </div>
  );
}

// ── TreasuryConsole (main export) ─────────────────────────────────────────────

// The owner's treasury overview. A dense summary strip up top (totals per
// container kind + grand total) with the per-container breakdown available
// on demand, so the position is readable at a glance instead of a wall of
// half-empty cards.
//
// accountRows: the full TreasuryAccountRow list (with UUIDs) used by Consignar
// to write to the ledger via consignarDesde. accounts: the display-only
// TreasuryAccount list used for balances and grouping.
//
// transferMethods: transfer-type payment methods (fetched in page.tsx) needed
// by the "Agregar cuenta bancaria" form.
export function TreasuryConsole(props: {
  accounts: TreasuryAccount[];
  accountRows?: TreasuryAccountRow[];
  transferMethods?: PaymentMethodRow[];
  /** Total balance override (e.g. from tesoreria page with all accounts). */
  totalOverride?: number;
}) {
  const [showDetail, setShowDetail] = useState(false);

  const accountRows = props.accountRows ?? [];
  const transferMethods = (props.transferMethods ?? []).filter(
    m => m.type === 'transfer',
  );

  // EMPTY STATE: no vault or banco accounts yet → show CTA to create first one.
  const hasContainers = props.accounts.some(
    a => a.type === 'caja_fuerte' || a.type === 'banco',
  );

  if (props.accounts.length === 0 || !hasContainers) {
    return (
      <EmptyTreasuryState
        transferMethods={transferMethods}
        onCreated={() => {}}
      />
    );
  }

  // All active banco rows — passed to every vault's Consignar so the owner can
  // pick the destination bank from a list of real account UUIDs.
  const bankRows = accountRows.filter(r => r.type === 'banco');

  const cajas = props.accounts.filter(a => a.type === 'caja');
  const safe = props.accounts.filter(a => a.type === 'caja_fuerte');
  const banco = props.accounts.filter(a => a.type === 'banco');
  const total = props.totalOverride ?? sum(props.accounts);

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Dónde está la plata</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Saldo de cada lugar donde tenés dinero.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowDetail(v => !v)}
          aria-expanded={showDetail}
          className="
            flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs
            font-medium text-primary
            hover:bg-primary/5
          "
        >
          {showDetail ? 'Ocultar detalle' : 'Ver detalle'}
          <ChevronDown
            className={`
              size-3.5 transition-transform
              ${
    showDetail ? 'rotate-180' : ''
    }
            `}
          />
        </button>
      </div>

      <div className="
        mt-4 grid grid-cols-2 gap-3
        lg:grid-cols-4
      "
      >
        <SummaryCard
          highlight
          icon={<Wallet className="size-3.5" />}
          label="Plata total"
          amount={total}
        />
        {cajas.length > 0 && (
          <SummaryCard
            icon={<Coins className="size-3.5" />}
            label="Efectivo"
            amount={sum(cajas)}
            hint={countLabel(cajas.length, 'caja', 'cajas')}
          />
        )}
        {safe.length > 0 && (
          <SummaryCard
            icon={<Lock className="size-3.5" />}
            label="Caja fuerte"
            amount={sum(safe)}
          />
        )}
        {banco.length > 0 && (
          <SummaryCard
            icon={<Landmark className="size-3.5" />}
            label="Bancos"
            amount={sum(banco)}
            hint={countLabel(banco.length, 'cuenta', 'cuentas')}
          />
        )}
      </div>

      {showDetail && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {GROUPS.map((g) => {
            const items = props.accounts.filter(a => a.type === g.type);
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={g.type}>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {g.label}
                </div>
                <div className="
                  grid grid-cols-2 gap-3
                  lg:grid-cols-4
                "
                >
                  {items.map((a) => {
                    // For vault cards, find the matching TreasuryAccountRow to get the UUID
                    // for the Consignar ledger write.
                    const vaultRow
                      = a.type === 'caja_fuerte'
                        ? accountRows.find(r => r.type === 'caja_fuerte' && r.name === a.name)
                        : undefined;

                    return (
                      <div
                        key={a.key}
                        className="
                          rounded-lg border border-border bg-background p-3
                        "
                      >
                        <div className="truncate text-xs text-muted-foreground">
                          {a.name}
                        </div>
                        <div className="
                          mt-1 font-display text-lg font-medium tabular-nums
                        "
                        >
                          {money(a.balance)}
                        </div>
                        {a.note && (
                          <div className="
                            mt-0.5 text-[11px] text-muted-foreground
                          "
                          >
                            {a.note}
                          </div>
                        )}
                        {a.type === 'caja_fuerte' && vaultRow && bankRows.length > 0 && (
                          <Consignar
                            vaultAccountId={vaultRow.id}
                            bankAccounts={bankRows}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Actions toolbar: create containers + move money */}
          <ActionsToolbar
            accountRows={accountRows}
            transferMethods={transferMethods}
          />
        </div>
      )}
    </div>
  );
}
