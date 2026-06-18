'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { ArrowRightLeft, Coins, Landmark, Lock, Monitor, Plus } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';
import { groupByType } from './utils';

// ── Dashed connector SVG ─────────────────────────────────────────────────────

function Connector() {
  return (
    <svg
      width="40"
      height="2"
      viewBox="0 0 40 2"
      className="shrink-0 text-input"
      aria-hidden
    >
      <line
        x1="0"
        y1="1"
        x2="40"
        y2="1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

function VerticalConnectors({ count }: { count: number }) {
  return (
    <div
      className="flex shrink-0 flex-col justify-around py-[18px]"
      style={{ gap: count > 1 ? undefined : 0 }}
    >
      {/* Static decorative connectors — index key is safe for purely visual elements */}
      {/* eslint-disable-next-line react/no-array-index-key */}
      {Array.from({ length: count }).map((_, i) => <Connector key={i} />)}
    </div>
  );
}

// ── Place node in column 3 ───────────────────────────────────────────────────

function iconForAccount(type: string): React.ReactNode {
  if (type === 'caja') {
    return <Monitor className="size-[18px]" />;
  }
  if (type === 'caja_fuerte') {
    return <Lock className="size-[18px]" />;
  }
  if (type === 'banco') {
    return <Landmark className="size-[18px]" />;
  }
  return <Coins className="size-[18px]" />;
}

function PlaceNode({
  account,
  accent,
  onMove,
}: {
  account: TreasuryAccount;
  accent: { icon: string; bg: string };
  /**
   * When omitted, the place is read-only (no "mover" button) — e.g. POS cajas,
   * whose cash is managed at the device (open/close), not moved from treasury.
   */
  onMove?: (key: string) => void;
}) {
  return (
    <div
      className="
        group relative flex items-center gap-3 rounded-[14px] border
        border-border bg-card p-3.5 transition-[border-color,box-shadow]
        hover:border-input hover:shadow-sm
      "
    >
      <span
        className={`
          flex size-9 shrink-0 items-center justify-center rounded-[11px]
          ${accent.bg}
          ${accent.icon}
        `}
      >
        {iconForAccount(account.type)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-[650]">{account.name}</div>
        <div className="font-display text-[18px] font-semibold tabular-nums">
          {money(account.balance)}
        </div>
      </div>
      {onMove && (
        <button
          type="button"
          onClick={() => onMove(account.key)}
          title="Mover desde aquí"
          className="
            flex size-8 shrink-0 items-center justify-center rounded-[9px]
            border border-border bg-card text-secondary-foreground opacity-0
            transition-[opacity,background-color]
            group-hover:opacity-100
            hover:border-input hover:bg-muted
          "
        >
          <ArrowRightLeft className="size-[15px]" />
        </button>
      )}
    </div>
  );
}

// ── Agregar lugar affordance ─────────────────────────────────────────────────

function AddPlaceButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        flex min-h-[56px] items-center justify-center gap-2 rounded-[14px]
        border border-dashed border-input bg-transparent px-3
        text-muted-foreground transition-[border-color,background-color,color]
        hover:border-primary hover:bg-primary/5 hover:text-primary
      "
    >
      <Plus className="size-[18px]" />
      <span className="text-[12.5px] font-semibold">
        Agregar lugar (caja fuerte o banco)
      </span>
    </button>
  );
}

// ── Main: flow diagram ───────────────────────────────────────────────────────

type MoneyFlowProps = {
  accounts: TreasuryAccount[];
  total: number;
  sinUbicar: number;
  pendingCount: number;
  /**
   * Called when the user clicks the move button on a place.
   * Receives the account key to pre-fill the TransferWizard source.
   */
  onMoveFromPlace: (key: string) => void;
  /**
   * Called when the user clicks "Agregar lugar" from within the diagram.
   * Opens the CreateSlideover from the parent.
   */
  onAddPlace: () => void;
};

/**
 * "Dónde está la plata" flow diagram.
 * 3 columns: Total empresa → Efectivo/Bancos/Sin ubicar buckets → individual places.
 * Connectors are dashed SVG lines.
 * Per-place move button calls onMoveFromPlace(key) → opens TransferWizard pre-filled.
 * "Agregar lugar" button calls onAddPlace() → opens CreateSlideover.
 */
export function MoneyFlow({
  accounts,
  total,
  sinUbicar,
  pendingCount,
  onMoveFromPlace,
  onAddPlace,
}: MoneyFlowProps) {
  const tree = groupByType(accounts);

  // Flatten the places for column 3 (efectivo → bancos order)
  const efectivoPlaces = tree.efectivo;
  const bancosPlaces = tree.bancos;

  const numConnectors = Math.max(efectivoPlaces.length, bancosPlaces.length, 1);

  // Bucket rows for column 2
  const buckets = [
    {
      key: 'efectivo',
      label: 'Efectivo',
      amount: tree.efectivo.reduce((s, a) => s + a.balance, 0),
      icon: <Coins className="size-4" />,
      toneIcon: 'text-success',
      toneBg: 'bg-success/10',
    },
    {
      key: 'bancos',
      label: 'Bancos',
      amount: tree.bancos.reduce((s, a) => s + a.balance, 0),
      icon: <Landmark className="size-4" />,
      toneIcon: 'text-chart-5',
      toneBg: 'bg-chart-5/10',
    },
  ];

  if (accounts.length === 0) {
    return (
      <div className="
        rounded-xl border border-border bg-card p-[22px] shadow-xs
      "
      >
        <h2 className="text-[17px] font-semibold tracking-tight">Dónde está la plata</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Todavía no hay contenedores configurados. Agregá una caja fuerte o
          cuenta bancaria para empezar.
        </p>
        <button
          type="button"
          onClick={onAddPlace}
          className="
            mt-4 flex h-10 items-center gap-2 rounded-[10px] border
            border-dashed border-input px-4 text-[13px] font-semibold
            text-muted-foreground transition-colors
            hover:border-primary hover:bg-primary/5 hover:text-primary
          "
        >
          <Plus className="size-4" />
          Agregar lugar
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-[22px] shadow-xs">
      {/* Section header */}
      <h2 className="text-[17px] font-semibold tracking-tight">Dónde está la plata</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        Seguí la plata: del total se reparte en efectivo y bancos, y de ahí a cada lugar.
      </p>

      {/* Flow columns */}
      <div className="mt-[18px] flex items-stretch gap-2">
        {/* Col 1 — Total empresa */}
        <div className="flex w-[200px] shrink-0 items-center">
          <div
            className="
              w-full rounded-[14px] border border-primary/20 bg-primary/5 p-5
            "
          >
            <div
              className="
                text-[11px] font-semibold tracking-widest text-primary uppercase
              "
            >
              Total empresa
            </div>
            <div
              className="
                mt-1.5 font-display text-[28px] font-semibold tracking-tight
                text-brand-ink tabular-nums
              "
            >
              {money(total)}
            </div>
          </div>
        </div>

        {/* Connector col 1→2 */}
        <div className="flex items-center">
          <Connector />
        </div>

        {/* Col 2 — Buckets */}
        <div className="flex w-[200px] shrink-0 flex-col justify-center gap-4">
          {buckets.map(b => (
            <div
              key={b.key}
              className="
                flex items-center gap-[11px] rounded-xl border border-border
                bg-muted p-3.5
              "
            >
              <span
                className={`
                  flex size-8 shrink-0 items-center justify-center rounded-lg
                  ${b.toneBg}
                  ${b.toneIcon}
                `}
              >
                {b.icon}
              </span>
              <div>
                <div className="
                  text-[12.5px] font-semibold text-secondary-foreground
                "
                >
                  {b.label}
                </div>
                <div className="
                  font-display text-[15px] font-[650] tabular-nums
                "
                >
                  {money(b.amount)}
                </div>
              </div>
            </div>
          ))}

          {/* Sin ubicar bucket — only when pending */}
          {pendingCount > 0 && (
            <div
              className="
                flex items-center gap-[11px] rounded-xl border border-warn
                bg-warn/10 p-3.5
              "
            >
              <span
                className="
                  flex size-8 shrink-0 items-center justify-center rounded-lg
                  bg-card text-warn
                "
              >
                <Coins className="size-4" />
              </span>
              <div className="flex-1">
                <div className="text-[12.5px] font-semibold text-warn">
                  Sin ubicar
                </div>
                <div className="
                  font-display text-[15px] font-[650] tabular-nums
                "
                >
                  {money(sinUbicar)}
                </div>
              </div>
              <span
                className="size-2.5 shrink-0 rounded-full bg-warn"
                style={{ animation: 'tsrPulse 1.8s infinite' }}
              />
            </div>
          )}
        </div>

        {/* Connector col 2→3 */}
        <VerticalConnectors count={numConnectors} />

        {/* Col 3 — Individual places */}
        <div className="flex flex-1 flex-col gap-2.5">
          {efectivoPlaces.map(p => (
            <PlaceNode
              key={p.key}
              account={p}
              accent={{ icon: 'text-success', bg: 'bg-success/10' }}
              // POS cajas are read-only here: their cash moves only at the device
              // (open/close), never from treasury.
              onMove={p.type === 'caja' ? undefined : onMoveFromPlace}
            />
          ))}
          {bancosPlaces.map(p => (
            <PlaceNode
              key={p.key}
              account={p}
              accent={{ icon: 'text-chart-5', bg: 'bg-chart-5/10' }}
              onMove={onMoveFromPlace}
            />
          ))}

          {/* Agregar lugar */}
          <AddPlaceButton onClick={onAddPlace} />
        </div>
      </div>
    </div>
  );
}
