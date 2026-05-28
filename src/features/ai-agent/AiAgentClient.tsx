'use client';

import type { AgentKind, CounterRow, PlanSnapshot } from '@/actions/plans';
import { useCallback, useState } from 'react';
import { currentPlan } from '@/actions/plans';
import { Button } from '@/components/ui/button';
import { ChatPanel } from './ChatPanel';
import { NoCreditsModal } from './NoCreditsModal';

const AGENTS: {
  kind: AgentKind;
  label: string;
  description: string;
  api: string;
}[] = [
  {
    kind: 'sales_manager',
    label: 'Sales Manager',
    description: 'Pregunta sobre ventas, productos, clientes e inventario.',
    api: '/api/ai/sales-manager',
  },
  {
    kind: 'customer_service',
    label: 'Customer Service',
    description: 'Atiende dudas de clientes sobre productos, precios y horarios.',
    api: '/api/ai/customer-service',
  },
];

function getCounter(counters: CounterRow[], kind: AgentKind): CounterRow {
  return (
    counters.find(c => c.agentKind === kind) ?? {
      agentKind: kind,
      used: 0,
      monthlyLimit: 0,
      toppedUp: 0,
      remaining: 0,
      resetAt: null,
    }
  );
}

export function AiAgentClient({
  initialSnapshot,
}: {
  initialSnapshot: PlanSnapshot;
}) {
  const [activeAgent, setActiveAgent] = useState<AgentKind>('sales_manager');
  const [counters, setCounters] = useState(initialSnapshot.counters);
  const [showNoCredits, setShowNoCredits] = useState(false);

  const counter = getCounter(counters, activeAgent);
  const cap = counter.monthlyLimit + counter.toppedUp;

  const refreshCounters = useCallback(async () => {
    try {
      const snap = await currentPlan();
      setCounters(snap.counters);
    } catch {
      // non-fatal
    }
  }, []);

  const handleNoCredits = useCallback(() => {
    setShowNoCredits(true);
  }, []);

  const agent = AGENTS.find(a => a.kind === activeAgent)!;

  return (
    <div className="space-y-6">
      {/* Tab bar + counter */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {AGENTS.map(a => (
            <Button
              key={a.kind}
              variant={activeAgent === a.kind ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveAgent(a.kind)}
            >
              {a.label}
            </Button>
          ))}
        </div>

        <div className="text-sm text-muted-foreground">
          Créditos restantes:
          {' '}
          <span className={`
            font-semibold
            ${counter.remaining <= 0
      ? `text-destructive`
      : `text-foreground`}
          `}
          >
            {counter.remaining.toLocaleString('es-CO')}
            {' / '}
            {cap.toLocaleString('es-CO')}
          </span>
        </div>
      </div>

      {/* Chat */}
      <ChatPanel
        key={activeAgent}
        api={agent.api}
        placeholder={
          activeAgent === 'sales_manager'
            ? '¿Cuál fue mi día más vendido este mes?'
            : '¿Tienen arroz disponible?'
        }
        onMessageComplete={refreshCounters}
        onNoCredits={handleNoCredits}
      />

      {showNoCredits && (
        <NoCreditsModal onClose={() => setShowNoCredits(false)} />
      )}
    </div>
  );
}
