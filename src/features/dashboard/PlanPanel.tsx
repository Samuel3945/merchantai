import type { AgentKind } from '@/actions/plans';
import type { PosDeviceQuota } from '@/actions/pos-tokens';
import type { SaturationReport } from '@/actions/sales';
import { Banknote, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { getCashierQuota } from '@/actions/employees';
import { currentPlan } from '@/actions/plans';
import { getPosDeviceQuota } from '@/actions/pos-tokens';
import { getCashierSaturation } from '@/actions/sales';
import { cn } from '@/utils/Helpers';

// Mirrors the labels used on the Plans screen so the two views stay in sync.
const AGENT_LABELS: Record<AgentKind, string> = {
  sales_manager: 'Créditos inteligentes',
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

// Picks the headline + body + CTA for a saturated caja. The action stays honest
// about quota: if the plan still has a free caja slot, the fix is to ACTIVATE
// the one already paid for; only when the plan is maxed do we suggest upgrading.
function saturationNotice(
  saturation: SaturationReport,
  posQuota: PosDeviceQuota | null,
): { title: string; body: string; cta: string; href: string } | null {
  if (!saturation.saturated) {
    return null;
  }

  const saturatedCajas = saturation.cajas.filter(c => c.saturated);
  const named = (s: string | null): s is string => Boolean(s);
  // Only pinpoint a sede when the business actually runs more than one branch —
  // otherwise "Tu sede Centro" is noise for a single-location store.
  const allSedes = new Set(saturation.cajas.map(c => c.sede).filter(named));
  const saturatedSedes = [...new Set(saturatedCajas.map(c => c.sede).filter(named))];
  const isMultiBranch = allSedes.size > 1;
  const oneSede = isMultiBranch && saturatedSedes.length === 1
    ? saturatedSedes[0]
    : null;

  let title: string;
  if (oneSede) {
    title = `Tu sede ${oneSede} ya no da abasto`;
  } else if (isMultiBranch && saturatedSedes.length > 1) {
    title = 'Varias sedes ya no dan abasto';
  } else if (saturatedCajas.length > 1) {
    title = 'Tus cajas ya no dan abasto';
  } else {
    title = 'Una sola caja ya no da abasto';
  }

  // Anchor the explanation to the saturated sede when we can name one.
  const where = oneSede ? ` en ${oneSede}` : '';
  const hasFreeSlot = posQuota != null && posQuota.remaining > 0;

  return hasFreeSlot
    ? {
        title,
        body:
          `Las ventas${where} entran casi sin pausa entre una y otra. Abrí otra `
          + 'caja para atender más rápido y evitar filas.',
        cta: 'Abrir otra caja →',
        href: '/dashboard/pos-cajeros',
      }
    : {
        title,
        body:
          `Las ventas${where} entran casi sin pausa entre una y otra. Tu plan `
          + 'llegó al máximo de cajas — sumá un cajero para abrir otra.',
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
export async function PlanPanel({ aiEnabled }: { aiEnabled: boolean }) {
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
              : aiEnabled
                ? 'La IA potencia y automatiza tu negocio.'
                : 'Acceso completo al software, sin compromiso.'}
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
        <Link
          href={notice.href}
          className="
            mb-4 flex items-center gap-3 rounded-xl border border-amber-700
            bg-[#FCF1DE] px-3.5 py-[13px] text-foreground transition-shadow
            hover:shadow-sm
            dark:border-amber-400 dark:bg-[#2E2410]
          "
        >
          <span className="
            inline-flex size-[34px] shrink-0 items-center justify-center
            rounded-[10px] bg-amber-700 text-white
            dark:bg-amber-400
          "
          >
            <Banknote className="size-[17px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">
              {notice.title}
            </span>
            <span className="mt-px block text-xs text-muted-foreground">
              {notice.body}
            </span>
          </span>
          <span className="
            inline-flex h-[34px] shrink-0 items-center rounded-md bg-amber-700
            px-3 text-sm font-semibold whitespace-nowrap text-white
            dark:bg-amber-400
          "
          >
            {notice.cta}
          </span>
        </Link>
      )}

      {aiEnabled && lowAny && (
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

      {aiEnabled && (activeAgents.length === 0
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
          ))}
    </div>
  );
}
