import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { currentPlan } from '@/actions/plans';
import { cn } from '@/utils/Helpers';

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  business: 'Business',
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
 * Shows the active plan, AI credit usage and renewal date, with a single
 * pointer to the plans screen — no permanent "buy" buttons, the upsell only
 * surfaces as a low-credit warning.
 */
export async function PlanPanel() {
  const { subscription, counters } = await currentPlan();

  const used = counters.reduce((acc, c) => acc + c.used, 0);
  const total = counters.reduce(
    (acc, c) => acc + c.monthlyLimit + c.toppedUp,
    0,
  );
  const remaining = Math.max(0, total - used);
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const lowCredits = total > 0 && pct >= 80;
  const renewal = subscription.periodEnd;

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
            Todos los módulos activos. La IA potencia y automatiza tu negocio.
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

      {lowCredits && (
        <div className="
          mb-4 flex items-center justify-between gap-3 rounded-md border
          border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700
        "
        >
          <span>
            Te quedan pocos créditos de IA (
            {numberFmt.format(remaining)}
            ). Considerá recargar o subir de plan.
          </span>
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

      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-3
      "
      >
        <div>
          <div className="
            text-[10px] font-bold tracking-widest text-muted-foreground
            uppercase
          "
          >
            Créditos IA restantes
          </div>
          <div className="mt-1 font-display text-2xl font-medium tabular-nums">
            {numberFmt.format(remaining)}
            <span className="text-sm font-normal text-muted-foreground">
              {' '}
              /
              {' '}
              {numberFmt.format(total)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full',
                pct >= 80 ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div>
          <div className="
            text-[10px] font-bold tracking-widest text-muted-foreground
            uppercase
          "
          >
            Consumo IA
          </div>
          <div className="mt-1 font-display text-2xl font-medium tabular-nums">
            {numberFmt.format(used)}
          </div>
          <div className="text-xs text-muted-foreground">
            créditos usados este período
          </div>
        </div>

        <div>
          <div className="
            text-[10px] font-bold tracking-widest text-muted-foreground
            uppercase
          "
          >
            Renovación
          </div>
          <div className="mt-1 font-display text-lg font-medium tabular-nums">
            {formatDate(renewal)}
          </div>
        </div>
      </div>
    </div>
  );
}
