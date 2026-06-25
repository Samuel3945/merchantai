'use client';

import type {
  AgentKind,
  CounterRow,
  PlanName,
  PlanSnapshot,
  PublicPlan,
} from '@/actions/plans';
import { useState, useTransition } from 'react';
import { topUp, upgradePlan } from '@/actions/plans';
import { Button } from '@/components/ui/button';

const AGENT_LABELS: Record<AgentKind, string> = {
  sales_manager: 'Sales Manager',
  customer_service: 'Customer Service',
  einvoice: 'Facturación electrónica',
};

const TOPUP_PRESETS: { requests: number; amountCop: number }[] = [
  { requests: 100, amountCop: 19_000 },
  { requests: 500, amountCop: 79_000 },
  { requests: 1000, amountCop: 139_000 },
];

// E-invoicing credits cost 50 COP each (1 credit = 1 emitted document).
const EINVOICE_CREDIT_PRICE_COP = 50;
const EINVOICE_TOPUP_PRESETS: { requests: number; amountCop: number }[] = [
  { requests: 100, amountCop: 100 * EINVOICE_CREDIT_PRICE_COP },
  { requests: 500, amountCop: 500 * EINVOICE_CREDIT_PRICE_COP },
  { requests: 1000, amountCop: 1000 * EINVOICE_CREDIT_PRICE_COP },
];

function topUpPresetsFor(agentKind: AgentKind) {
  return agentKind === 'einvoice' ? EINVOICE_TOPUP_PRESETS : TOPUP_PRESETS;
}

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
  counter,
  onTopUp,
}: {
  counter: CounterRow;
  onTopUp: () => void;
}) {
  const cap = counter.monthlyLimit + counter.toppedUp;
  const pct = cap > 0 ? Math.min(100, Math.round((counter.used / cap) * 100)) : 0;
  const exhausted = cap > 0 && counter.remaining <= 0;

  return (
    <div className="rounded-xl border border-border bg-background p-5">
      <div className="flex items-center justify-between">
        <div className="font-medium">{AGENT_LABELS[counter.agentKind]}</div>
        <Button size="sm" variant="outline" onClick={onTopUp}>
          Comprar recarga
        </Button>
      </div>

      <div className="mt-3 text-2xl font-semibold">
        {counter.used.toLocaleString('es-CO')}
        {' '}
        /
        {' '}
        {cap.toLocaleString('es-CO')}
      </div>
      <div className="text-xs text-muted-foreground">
        {counter.monthlyLimit.toLocaleString('es-CO')}
        {' '}
        del plan
        {counter.toppedUp > 0
          ? ` + ${counter.toppedUp.toLocaleString('es-CO')} extra`
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
            : `${counter.remaining.toLocaleString('es-CO')} consultas disponibles`}
      </div>
    </div>
  );
}

function TopUpModal({
  agentKind,
  busy,
  onClose,
  onConfirm,
}: {
  agentKind: AgentKind;
  busy: boolean;
  onClose: () => void;
  onConfirm: (requests: number, amountCop: number) => void;
}) {
  const [selected, setSelected] = useState(0);
  const presets = topUpPresetsFor(agentKind);
  const preset = presets[selected]!;

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-xl bg-background p-6 shadow-lg">
        <div className="text-lg font-semibold">
          Comprar recarga ·
          {' '}
          {AGENT_LABELS[agentKind]}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Suma consultas extra al contador actual. No expiran este mes.
        </div>

        <div className="mt-4 space-y-2">
          {presets.map((p, i) => (
            <label
              key={p.requests}
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
            onClick={() => onConfirm(preset.requests, preset.amountCop)}
            disabled={busy}
          >
            {busy ? 'Procesando…' : 'Confirmar compra'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PlansClient({
  initialSnapshot,
  plans,
  aiEnabled,
}: {
  initialSnapshot: PlanSnapshot;
  plans: PublicPlan[];
  aiEnabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [topUpAgent, setTopUpAgent] = useState<AgentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  const handleTopUp = (requests: number, amountCop: number) => {
    if (!topUpAgent) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const next = await topUp(topUpAgent, requests, amountCop);
        setSnapshot(next);
        setTopUpAgent(null);
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
            <div className="
              grid grid-cols-1 gap-4
              md:grid-cols-2
            "
            >
              {snapshot.counters.map(c => (
                <CounterCard
                  key={c.agentKind}
                  counter={c}
                  onTopUp={() => setTopUpAgent(c.agentKind)}
                />
              ))}
            </div>
          </section>

          {topUpAgent && (
            <TopUpModal
              agentKind={topUpAgent}
              busy={pending}
              onClose={() => setTopUpAgent(null)}
              onConfirm={handleTopUp}
            />
          )}
        </>
      )}
    </div>
  );
}
