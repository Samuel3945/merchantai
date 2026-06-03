import type { AgentKind } from '@/actions/plans';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { currentPlan } from '@/actions/plans';
import { cn } from '@/utils/Helpers';

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  business: 'Business',
};

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

/**
 * SaaS plan snapshot for the Resumen, adapted from Tiendademo's SaasPanel.
 * Tiendademo had a single credit pool; MerchantAI tracks credits per AI agent
 * (separate, non-interchangeable limits), so we show one bar per agent that the
 * plan includes — never a misleading sum. The upsell only surfaces as a
 * low-credit warning.
 */
export async function PlanPanel() {
  const { subscription, counters } = await currentPlan();

  // Only agents the current plan actually grants credits for.
  const activeAgents = counters.filter(c => c.monthlyLimit + c.toppedUp > 0);
  const lowAny = activeAgents.some((c) => {
    const cap = c.monthlyLimit + c.toppedUp;
    return cap > 0 && c.remaining / cap <= 0.2;
  });

  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">
              Plan
              {' '}
              {PLAN_LABEL[subscription.plan] ?? subscription.plan}
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            La IA potencia y automatiza tu negocio. Renovación:
            {' '}
            {formatDate(subscription.periodEnd)}
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
