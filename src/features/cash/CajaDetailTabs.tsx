'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '@/utils/Helpers';

// Tabbed navigation for the caja detail drill-down. Splits the three histories
// — financial activity, closures (arqueos) and the admin audit trail — so the
// page never stacks three large lists at once. Panels stay mounted and toggle
// visibility so each tab keeps its own filter/scroll state across switches.

type TabKey = 'activity' | 'closures' | 'audit';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'activity', label: 'Actividad' },
  { key: 'closures', label: 'Cierres' },
  { key: 'audit', label: 'Auditoría' },
];

export function CajaDetailTabs(props: {
  activity: ReactNode;
  closures: ReactNode;
  audit: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>('activity');

  return (
    <div>
      <div
        role="tablist"
        aria-label="Detalle de la caja"
        className="
          inline-flex w-full rounded-xl border border-border bg-muted/40 p-1
          sm:w-auto
        "
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={cn(
                `
                  flex-1 rounded-lg px-4 py-1.5 text-sm font-medium
                  transition-colors
                  sm:flex-none
                `,
                active
                  ? 'bg-card text-foreground shadow-xs'
                  : `
                    text-muted-foreground
                    hover:text-foreground
                  `,
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <div role="tabpanel" className={cn(tab !== 'activity' && 'hidden')}>
          {props.activity}
        </div>
        <div role="tabpanel" className={cn(tab !== 'closures' && 'hidden')}>
          {props.closures}
        </div>
        <div role="tabpanel" className={cn(tab !== 'audit' && 'hidden')}>
          {props.audit}
        </div>
      </div>
    </div>
  );
}
