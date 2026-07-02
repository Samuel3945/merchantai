'use client';

import type {
  PlanName,
  PlanSnapshot,
  PoolBalance,
  PublicPlan,
} from '@/actions/plans';
import type { TopUpPackage } from '@/libs/topup-catalog';
import { useEffect, useState, useTransition } from 'react';
import { createTopUpCheckout, upgradePlan } from '@/actions/plans';
import { Button } from '@/components/ui/button';

const copFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function PlanCard({
  plan,
  current,
  busy,
  onSelect,
}: {
  plan: PublicPlan;
  current: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`
        rounded-xl border px-6 py-8
        ${
    current ? 'border-primary shadow-md' : 'border-border'
    }
      `}
    >
      <div className="text-lg font-semibold">{plan.name}</div>
      <div className="mt-1 text-sm text-muted-foreground">{plan.description}</div>
      <div className="mt-4 text-3xl font-bold">
        {`COP ${plan.priceMonthlyCop.toLocaleString('es-CO')} / mes`}
      </div>

      <ul className="mt-6 space-y-2 text-sm">
        {plan.featureBullets.map(f => (
          <li key={f} className="flex gap-2">
            <span className="text-primary">•</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <Button
        className="mt-6 w-full"
        variant={current ? 'secondary' : 'default'}
        disabled={current || busy}
        onClick={onSelect}
      >
        {current ? 'Plan actual' : 'Cambiar a este plan'}
      </Button>
    </div>
  );
}

function CounterCard({
  pool,
  onTopUp,
}: {
  pool: PoolBalance;
  onTopUp: () => void;
}) {
  const cap = pool.monthlyLimit + pool.toppedUp;
  const pct = cap > 0 ? Math.min(100, Math.round((pool.used / cap) * 100)) : 0;
  const exhausted = cap > 0 && pool.remaining <= 0;

  return (
    <div className="rounded-xl border border-border bg-background p-5">
      <div className="flex items-center justify-between">
        <div className="font-medium">Créditos disponibles</div>
        <Button size="sm" variant="outline" onClick={onTopUp}>
          Comprar recarga
        </Button>
      </div>

      <div className="mt-3 text-2xl font-semibold">
        {pool.used.toLocaleString('es-CO')}
        {' '}
        /
        {' '}
        {cap.toLocaleString('es-CO')}
      </div>
      <div className="text-xs text-muted-foreground">
        {pool.monthlyLimit.toLocaleString('es-CO')}
        {' '}
        del plan
        {pool.toppedUp > 0
          ? ` + ${pool.toppedUp.toLocaleString('es-CO')} extra`
          : ''}
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`
            h-full
            ${exhausted ? 'bg-destructive' : 'bg-primary'}
          `}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div
        className={`
          mt-2 text-xs
          ${
    exhausted ? 'text-destructive' : 'text-muted-foreground'
    }
        `}
      >
        {cap === 0
          ? 'No incluido en tu plan'
          : exhausted
            ? 'Sin consultas disponibles'
            : `${pool.remaining.toLocaleString('es-CO')} consultas disponibles`}
      </div>
    </div>
  );
}

function TopUpModal({
  packages,
  busy,
  onClose,
  onConfirm,
}: {
  packages: TopUpPackage[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (packageId: string) => void;
}) {
  const [selected, setSelected] = useState(0);
  const pkg = packages[selected]!;

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-xl bg-background p-6 shadow-lg">
        <div className="text-lg font-semibold">
          Comprar recarga
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Suma consultas extra al pool actual. No expiran este mes.
        </div>

        <div className="mt-4 space-y-2">
          {packages.map((p, i) => (
            <label
              key={p.id}
              className={`
                flex cursor-pointer items-center justify-between rounded-lg
                border px-4 py-3
                ${
            selected === i ? 'border-primary bg-muted/50' : 'border-border'
            }
              `}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="topup"
                  checked={selected === i}
                  onChange={() => setSelected(i)}
                />
                <div>
                  <div className="font-medium">
                    +
                    {p.requests.toLocaleString('es-CO')}
                    {' '}
                    consultas
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {copFmt.format(p.amountCop / p.requests)}
                    {' '}
                    por consulta
                  </div>
                </div>
              </div>
              <div className="font-semibold">{copFmt.format(p.amountCop)}</div>
            </label>
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => onConfirm(pkg.id)}
            disabled={busy}
          >
            {busy ? 'Procesando…' : 'Ir a pagar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PlansClient({
  initialSnapshot,
  plans,
  packages,
  aiEnabled,
}: {
  initialSnapshot: PlanSnapshot;
  plans: PublicPlan[];
  packages: TopUpPackage[];
  aiEnabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTopUpRef, setPendingTopUpRef] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Best-effort: show a "confirming payment" banner when redirected back from
  // Wompi with ?topup=<reference>. No polling — the counters refresh next
  // time the page loads (or when the webhook has already granted the credits).
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('topup');
    if (ref) {
      setPendingTopUpRef(ref);
    }
  }, []);

  const handleUpgrade = (plan: PlanName) => {
    setError(null);
    startTransition(async () => {
      try {
        const next = await upgradePlan(plan);
        setSnapshot(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  };

  const handleTopUp = (packageId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        const { url } = await createTopUpCheckout(packageId);
        window.location.href = url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  };

  return (
    <div className="space-y-10">
      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {pendingTopUpRef && (
        <div className="
          rounded-md border border-border bg-muted/50 px-4 py-3 text-sm
          text-muted-foreground
        "
        >
          Estamos confirmando tu pago; los créditos se acreditan al confirmar.
        </div>
      )}

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Tu plan</h2>
          <div className="text-sm text-muted-foreground">
            Activo:
            {' '}
            <span className="font-medium text-foreground">
              {snapshot.subscription.planName}
            </span>
          </div>
        </div>

        <div className="
          grid grid-cols-1 gap-4
          md:grid-cols-3
        "
        >
          {plans.map(p => (
            <PlanCard
              key={p.slug}
              plan={p}
              current={snapshot.subscription.plan === p.slug}
              busy={pending}
              onSelect={() => handleUpgrade(p.slug)}
            />
          ))}
        </div>
      </section>

      {aiEnabled && (
        <>
          <section>
            <h2 className="mb-4 text-lg font-semibold">Consumo del periodo</h2>
            <div className="max-w-md">
              <CounterCard
                pool={snapshot.pool}
                onTopUp={() => setTopUpOpen(true)}
              />
            </div>
          </section>

          {topUpOpen && (
            <TopUpModal
              packages={packages}
              busy={pending}
              onClose={() => setTopUpOpen(false)}
              onConfirm={handleTopUp}
            />
          )}
        </>
      )}
    </div>
  );
}
