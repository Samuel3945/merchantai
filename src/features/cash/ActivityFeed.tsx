'use client';

import type { CashMovement } from '@/libs/cash-helpers';
import { cn } from '@/utils/Helpers';
import { describeMovement, money, relativeTime } from './cash-ui';

/**
 * Bank-app style movement list. Each row shows direction icon, motivo, an
 * optional detail (category or free-text reason) with relative time, and the
 * signed amount. Renders historical movement types gracefully via cash-ui.
 */
export function ActivityFeed(props: { movements: CashMovement[] }) {
  if (props.movements.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-muted-foreground">
        Sin movimientos todavía. Las ventas en efectivo y los registros manuales
        aparecerán acá.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {props.movements.map((m) => {
        const d = describeMovement(m);
        const amount = Number.parseFloat(m.amount) || 0;
        const isIn = d.direction === 'in';
        return (
          <li key={m.id} className="flex items-center gap-3 px-5 py-3">
            <span
              className={cn(
                `
                  flex size-9 shrink-0 items-center justify-center rounded-full
                  text-base
                `,
                isIn
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive',
              )}
              aria-hidden="true"
            >
              {isIn ? '↑' : '↓'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{d.title}</div>
              <div className="truncate text-xs text-muted-foreground">
                {d.detail ? `${d.detail} · ` : ''}
                {relativeTime(m.createdAt)}
              </div>
            </div>
            <div
              className={cn(
                'shrink-0 text-sm font-semibold tabular-nums',
                isIn ? 'text-success' : 'text-foreground',
              )}
            >
              {isIn ? '+' : '−'}
              {money(amount)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
