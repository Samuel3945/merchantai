'use client';

import type { TreasuryAccount } from '@/libs/treasury';
import { AlertTriangle, Bike, Check, Coins, Landmark } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';
import { sumBancos, sumEfectivo, sumTransito } from './utils';

function PulseDot() {
  return (
    <span
      className="
        size-2.5 shrink-0 animate-[tsrPulse_1.8s_infinite] rounded-full bg-warn
      "
      style={{
        boxShadow: '0 0 0 0 rgb(180 83 9 / 0.5)',
        animation: 'tsrPulse 1.8s infinite',
      }}
    />
  );
}

type BucketProps = {
  icon: React.ReactNode;
  label: string;
  amount: number;
  sub: string;
  toneIcon: string;
  toneBg: string;
  alert?: boolean;
};

function Bucket({ icon, label, amount, sub, toneIcon, toneBg, alert }: BucketProps) {
  return (
    <div
      className={`
        flex flex-1 flex-col gap-2.5 rounded-xl border p-[18px]
        ${alert ? 'border-warn' : 'border-border'}
      `}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`
            flex size-[30px] shrink-0 items-center justify-center rounded-lg
            ${toneBg}
            ${toneIcon}
          `}
        >
          {icon}
        </span>
        <span className="text-[13.5px] font-semibold text-secondary-foreground">
          {label}
        </span>
        {alert && <PulseDot />}
      </div>
      <div className="
        font-display text-[26px] font-medium tracking-tight tabular-nums
      "
      >
        {money(amount)}
      </div>
      <div
        className={`
          text-xs
          ${alert ? 'font-semibold text-warn' : 'text-muted-foreground'}
        `}
      >
        {sub}
      </div>
    </div>
  );
}

type TreasuryHeroProps = {
  accounts: TreasuryAccount[];
  total: number;
  pendingCount: number;
  // Efectivo "en la calle" en manos de los domiciliarios (ya incluido en `total`).
  enLaCalle?: number;
  courierCount?: number;
};

/**
 * Hero section: page title + big total card + 3 bucket cards (Efectivo / Bancos / Sin ubicar).
 * Matches View B design — large font-display total with a divider, side-by-side buckets.
 */
export function TreasuryHero({
  accounts,
  total,
  pendingCount,
  enLaCalle = 0,
  courierCount = 0,
}: TreasuryHeroProps) {
  const efectivo = sumEfectivo(accounts);
  const bancos = sumBancos(accounts);
  const sinUbicar = sumTransito(accounts);

  return (
    <div>
      {/* Page title */}
      <h1 className="font-display text-[30px] font-medium tracking-tight">
        Tesorería
      </h1>
      <p className="mt-1 text-[13.5px] text-muted-foreground">
        Todo el dinero de la empresa en un solo lugar.
      </p>

      {/* Hero card: big total + buckets */}
      <div
        className="
          mt-5 flex flex-wrap items-center gap-7 rounded-xl border border-border
          bg-card p-6 shadow-xs
        "
      >
        {/* Big total */}
        <div className="shrink-0 border-r border-border pr-7">
          <div
            className="
              text-[11px] font-semibold tracking-widest text-muted-foreground
              uppercase
            "
          >
            Dinero total de la empresa
          </div>
          <div className="
            mt-1.5 font-display text-[52px] leading-none font-medium
            tracking-tight tabular-nums
          "
          >
            {money(total)}
          </div>
        </div>

        {/* Bucket cards */}
        <div className="flex min-w-[360px] flex-1 gap-3.5">
          <Bucket
            icon={<Coins className="size-4" />}
            label="Efectivo"
            amount={efectivo}
            sub="Cajas + caja fuerte"
            toneIcon="text-success"
            toneBg="bg-success/10"
          />
          <Bucket
            icon={<Landmark className="size-4" />}
            label="Bancos"
            amount={bancos}
            sub="Cuentas bancarias"
            toneIcon="text-chart-5"
            toneBg="bg-chart-5/10"
          />
          {courierCount > 0 && (
            <Bucket
              icon={<Bike className="size-4" />}
              label="En la calle"
              amount={enLaCalle}
              sub={`${courierCount} ${courierCount === 1 ? 'domiciliario' : 'domiciliarios'}`}
              toneIcon="text-amber-600"
              toneBg="bg-amber-500/10"
            />
          )}
          {pendingCount > 0
            ? (
                <Bucket
                  icon={<AlertTriangle className="size-4" />}
                  label="Sin ubicar"
                  amount={sinUbicar}
                  sub={`${pendingCount} ${pendingCount === 1 ? 'pendiente' : 'pendientes'} por ubicar`}
                  toneIcon="text-warn"
                  toneBg="bg-warn/10"
                  alert
                />
              )
            : (
                <Bucket
                  icon={<Check className="size-4" />}
                  label="Sin ubicar"
                  amount={sinUbicar}
                  sub="Todo está ubicado ✓"
                  toneIcon="text-muted-foreground"
                  toneBg="bg-accent"
                />
              )}
        </div>
      </div>
    </div>
  );
}
