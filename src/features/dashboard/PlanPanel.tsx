import type { AgentKind } from '@/actions/plans';
import type { PosDeviceQuota } from '@/actions/pos-tokens';
import type { SaturationReport } from '@/actions/sales';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { getCashierQuota } from '@/actions/employees';
import { currentPlan } from '@/actions/plans';
import { getPosDeviceQuota } from '@/actions/pos-tokens';
import { getCashierSaturation } from '@/actions/sales';
import { cn } from '@/utils/Helpers';

// Mirrors the labels used on the Plans screen so the two views stay in sync.
const AGENT_LABELS: Record<AgentKind, string> = {
  sales_manager: 'Sales Manager',
  customer_service: 'Customer Service',
};

const numberFmt = new Intl.NumberFormat('es-CO');

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatDate(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

// Promise.allSettled keeps the panel resilient: if one counter fails (e.g. a
// permission error on a quota read), the rest still render instead of throwing
// the whole server component.
function settled<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null;
}

type QuotaTileProps = {
  label: string;
  used: number;
  limit: number;
};

// Small used/limit meter shared by the cajas and empleados counters.
function QuotaTile({ label, used, limit }: QuotaTileProps) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const full = limit > 0 && used >= limit;
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <div className="
        text-[10px] font-bold tracking-widest text-muted-foreground uppercase
      "
      >
        {label}
      </div>
      <div className="mt-1 font-display text-2xl font-medium tabular-nums">
        {numberFmt.format(used)}
        <span className="text-sm font-normal text-muted-foreground">
          {' '}
          /
          {' '}
          {numberFmt.format(limit)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full', full ? 'bg-amber-500' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// Picks the message + CTA for a saturated caja. The action is honest about
// quota: if the plan still has a free caja slot, the fix is to ACTIVATE the one
// already paid for — not to buy another.
function saturationNotice(
  saturation: SaturationReport,
  posQuota: PosDeviceQuota | null,
): { message: string; cta: string; href: string } | null {
  if (!saturation.saturated) {
    return null;
  }

  const saturatedCajas = saturation.cajas.filter(c => c.saturated);
  const onlyOne = saturatedCajas.length === 1 ? saturatedCajas[0] : undefined;
  const message
    = onlyOne?.deviceName
      ? `Tu caja "${onlyOne.deviceName}" está al límite.`
      : 'Una de tus cajas está al límite.';

  const hasFreeSlot = posQuota != null && posQuota.remaining > 0;

  return hasFreeSlot
    ? {
        message,
        cta: 'Activá otra caja (ya incluida) →',
        href: '/dashboard/pos-cajeros',
      }
    : {
        message,
        cta: 'Sumá un cajero a tu plan →',
        href: '/dashboard/plans',
      };
}

/**
 * Account counter for the Resumen: which plan you're on, your AI credits per
 * agent, your cajas (POS devices) and empleados (cashier seats) usage, plus two
 * proactive alerts — low AI credits, and a caja that's working at its limit.
 *
 * Tiendademo had a single credit pool; MerchantAI tracks credits per AI agent
 * (separate, non-interchangeable limits), so we show one bar per agent that the
 * plan includes — never a misleading sum.
 */
export async function PlanPanel() {
  const [
    { subscription, counters },
    posSettled,
    cashierSettled,
    saturationSettled,
  ] = await Promise.all([
    currentPlan(),
    Promise.allSettled([getPosDeviceQuota()]).then(([r]) => settled(r)),
    Promise.allSettled([getCashierQuota()]).then(([r]) => settled(r)),
    Promise.allSettled([getCashierSaturation()]).then(([r]) => settled(r)),
  ]);

  const posQuota = posSettled;
  const cashierQuota = cashierSettled;
  const saturation = saturationSettled;

  // Only agents the current plan actually grants credits for.
  const activeAgents = counters.filter(c => c.monthlyLimit + c.toppedUp > 0);
  const lowAny = activeAgents.some((c) => {
    const cap = c.monthlyLimit + c.toppedUp;
    return cap > 0 && c.remaining / cap <= 0.2;
  });

  const notice = saturation
    ? saturationNotice(saturation, posQuota)
    : null;

  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">
              Plan
              {' '}
              {subscription.planName}
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subscription.periodEnd
              ? `Renovación: ${formatDate(subscription.periodEnd)}`
              : 'La IA potencia y automatiza tu negocio.'}
          </p>
        </div>
        <Link
          href="/dashboard/plans"
          className="
            text-xs font-medium text-primary
            hover:underline
          "
        >
          Administrar plan →
        </Link>
      </div>

      {(posQuota || cashierQuota) && (
        <div className="
          mb-4 grid grid-cols-1 gap-3
          sm:grid-cols-2
        "
        >
          {posQuota && (
            <QuotaTile
              label="Cajeros"
              used={posQuota.used}
              limit={posQuota.limit}
            />
          )}
          {cashierQuota && (
            <QuotaTile
              label="Empleados"
              used={cashierQuota.used}
              limit={cashierQuota.limit}
            />
          )}
        </div>
      )}

      {notice && (
        <div className="
          mb-4 flex items-center justify-between gap-3 rounded-md border
          border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700
        "
        >
          <span>{notice.message}</span>
          <Link
            href={notice.href}
            className="
              shrink-0 font-semibold
              hover:underline
            "
          >
            {notice.cta}
          </Link>
        </div>
      )}

      {lowAny && (
        <div className="
          mb-4 flex items-center justify-between gap-3 rounded-md border
          border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700
        "
        >
          <span>Te quedan pocos créditos de IA. Recargá o subí de plan.</span>
          <Link
            href="/dashboard/plans"
            className="
              shrink-0 font-semibold
              hover:underline
            "
          >
            Recargar
          </Link>
        </div>
      )}

      {activeAgents.length === 0
        ? (
            <div className="
              flex flex-wrap items-center justify-between gap-3 rounded-md
              bg-muted/40 p-3 text-sm
            "
            >
              <span className="text-muted-foreground">
                Tu plan no incluye créditos de IA. Subí a Pro o Business para
                activar los agentes.
              </span>
              <Link
                href="/dashboard/plans"
                className="
                  shrink-0 text-xs font-semibold text-primary
                  hover:underline
                "
              >
                Ver planes →
              </Link>
            </div>
          )
        : (
            <div className={cn(
              'grid grid-cols-1 gap-4',
              activeAgents.length > 1 && 'sm:grid-cols-2',
            )}
            >
              {activeAgents.map((c) => {
                const cap = c.monthlyLimit + c.toppedUp;
                const pct = cap > 0 ? Math.min(100, (c.used / cap) * 100) : 0;
                return (
                  <div key={c.agentKind}>
                    <div className="
                      flex items-center justify-between text-[10px] font-bold
                      tracking-widest text-muted-foreground uppercase
                    "
                    >
                      <span>{AGENT_LABELS[c.agentKind]}</span>
                      {c.toppedUp > 0 && (
                        <span className="text-primary">
                          +
                          {numberFmt.format(c.toppedUp)}
                          {' '}
                          extra
                        </span>
                      )}
                    </div>
                    <div className="
                      mt-1 font-display text-2xl font-medium tabular-nums
                    "
                    >
                      {numberFmt.format(c.remaining)}
                      <span className="
                        text-sm font-normal text-muted-foreground
                      "
                      >
                        {' '}
                        /
                        {' '}
                        {numberFmt.format(cap)}
                      </span>
                    </div>
                    <div className="
                      mt-2 h-1.5 overflow-hidden rounded-full bg-muted
                    "
                    >
                      <div
                        className={cn(
                          'h-full',
                          pct >= 80 ? 'bg-amber-500' : 'bg-primary',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {numberFmt.format(c.used)}
                      {' '}
                      usados este período
                    </div>
                  </div>
                );
              })}
            </div>
          )}
    </div>
  );
}
