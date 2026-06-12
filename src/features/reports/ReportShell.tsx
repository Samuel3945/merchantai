'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Button } from '@/components/ui/button';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';

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
  /**
   * Report-specific filters rendered inside the same filter bar, next to the
   * period picker — pass labeled fields (see the sales page filter bar).
   */
  extraFilters?: ReactNode;
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
  extraFilters,
  children,
}: ReportShellProps) {
  const today = todayBogota();
  const [start, setStart] = useState(addDays(today, -29));
  const [end, setEnd] = useState(today);
  const [activePreset, setActivePreset] = useState<string | null>('30d');
  const [pending, startTransition] = useTransition();

  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', '90d', 'mtd', 'lastMonth']),
    [],
  );

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
        <div className="space-y-3 rounded-md border bg-muted/30 p-4">
          <div className="
            grid grid-cols-1 gap-3
            sm:grid-cols-2
            lg:grid-cols-4
          "
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Periodo
              </span>
              <DateRangePicker
                start={start}
                end={end}
                compare={false}
                showCompare={false}
                activePreset={activePreset}
                presets={presetOptions}
                maxDate={today}
                onApply={(next) => {
                  setActivePreset(next.preset);
                  reload(next.start, next.end);
                }}
                triggerClassName="w-full"
              />
            </div>
            {extraFilters}
          </div>
          {pending && (
            <span className="text-xs text-muted-foreground">Cargando…</span>
          )}
        </div>
      )}

      {children({ start, end, pending, reload })}
    </div>
  );
}
