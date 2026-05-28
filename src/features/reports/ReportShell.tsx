'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function todayBogota(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type ReportShellProps = {
  title: string;
  showDateRange?: boolean;
  onExportCSV?: () => void;
  onExportPDF?: () => void;
  children: (ctx: {
    start: string;
    end: string;
    pending: boolean;
    reload: (s: string, e: string) => void;
  }) => ReactNode;
  onLoad?: (start: string, end: string) => Promise<void>;
};

export function ReportShell({
  title,
  showDateRange = true,
  onExportCSV,
  onExportPDF,
  children,
}: ReportShellProps) {
  const today = todayBogota();
  const [start, setStart] = useState(addDays(today, -29));
  const [end, setEnd] = useState(today);
  const [pending, startTransition] = useTransition();

  function reload(s: string, e: string) {
    startTransition(() => {
      setStart(s);
      setEnd(e);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/dashboard/reports"
            className="
              text-xs text-muted-foreground
              hover:underline
            "
          >
            &larr; Todos los reportes
          </Link>
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        <div className="flex gap-2">
          {onExportCSV && (
            <Button variant="secondary" size="sm" onClick={onExportCSV}>
              Exportar CSV
            </Button>
          )}
          {onExportPDF && (
            <Button variant="secondary" size="sm" onClick={onExportPDF}>
              Exportar PDF
            </Button>
          )}
        </div>
      </div>

      {showDateRange && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Desde</label>
            <input
              type="date"
              value={start}
              max={end}
              onChange={e => reload(e.target.value, end)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Hasta</label>
            <input
              type="date"
              value={end}
              min={start}
              max={today}
              onChange={e => reload(start, e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => reload(addDays(today, -6), today)}
            >
              7d
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => reload(addDays(today, -29), today)}
            >
              30d
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => reload(addDays(today, -89), today)}
            >
              90d
            </Button>
          </div>
          {pending && (
            <span className="text-xs text-muted-foreground">Cargando...</span>
          )}
        </div>
      )}

      {children({ start, end, pending, reload })}
    </div>
  );
}
