'use client';

import type { CashSecurityStatus } from '@/actions/cash';
import { Button } from '@/components/ui/button';
import { riskLevelLabel } from '@/libs/cash-security-policy';
import { cn } from '@/utils/Helpers';
import { money } from './cash-ui';

const LEVEL_UI: Record<
  'preventivo' | 'alto' | 'critico',
  { container: string; accent: string; title: string; icon: string }
> = {
  preventivo: {
    container: 'border-warn/30 bg-warn/5',
    accent: 'text-warn',
    icon: '👀',
    title: 'Tu caja se acerca al nivel recomendado para un retiro',
  },
  alto: {
    container: 'border-warn/50 bg-warn/10',
    accent: 'text-warn',
    icon: '⚠',
    title: 'Recomendamos realizar un retiro de seguridad',
  },
  critico: {
    container: 'border-destructive/50 bg-destructive/10',
    accent: 'text-destructive',
    icon: '⚠',
    title: 'El efectivo supera ampliamente el nivel seguro',
  },
};

/**
 * Behavioural cash-security banner. Shows a learning state until there's enough
 * history, stays silent at `normal`, and escalates from a soft preventive nudge
 * to a prominent critical card — always offering a shortcut to record a cash-out.
 */
export function CashSecurityAlert(props: {
  security: CashSecurityStatus;
  onWithdraw: () => void;
}) {
  const { security } = props;

  if (security.state === 'learning' || security.level === 'normal') {
    return null;
  }

  const ui = LEVEL_UI[security.level];

  return (
    <div className={cn('rounded-xl border p-5', ui.container)}>
      <div className="
        flex flex-col gap-4
        sm:flex-row sm:items-center sm:justify-between
      "
      >
        <div className="min-w-0">
          <div className={cn('flex items-center gap-2 font-semibold', ui.accent)}>
            <span aria-hidden="true">{ui.icon}</span>
            {ui.title}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              Efectivo actual:
              {' '}
              <span className="font-semibold text-foreground tabular-nums">
                {money(security.currentCash)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Nivel recomendado:
              {' '}
              <span className="font-semibold text-foreground tabular-nums">
                {money(security.threshold)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Riesgo:
              {' '}
              <span className={cn('font-semibold', ui.accent)}>
                {riskLevelLabel(security.level)}
              </span>
            </span>
          </div>
        </div>
        <Button
          className="shrink-0"
          variant={security.level === 'critico' ? 'destructive' : 'default'}
          onClick={props.onWithdraw}
        >
          Registrar salida
        </Button>
      </div>
    </div>
  );
}
