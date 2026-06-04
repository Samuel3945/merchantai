'use client';

import type { DateRange } from 'react-day-picker';
import type { RangeOption } from '@/utils/DateRange';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/utils/Helpers';

export type PresetOption = RangeOption;

type Props = {
  start: string;
  end: string;
  compare: boolean;
  activePreset: string | null;
  presets: PresetOption[];
  maxDate: string;
  onApply: (next: {
    start: string;
    end: string;
    compare: boolean;
    preset: string | null;
  }) => void;
  /** Show the "compare previous period" toggle. Dashboard uses it; sales does not. */
  showCompare?: boolean;
  /** When provided, renders a "Limpiar" action that resets the range filter. */
  onClear?: () => void;
  /** Extra classes for the trigger button (e.g. "w-full" inside a filter grid). */
  triggerClassName?: string;
};

// ISO 'YYYY-MM-DD' <-> local Date, kept TZ-neutral so the calendar shows the
// same calendar day the string encodes (no UTC drift).
function isoToDate(iso?: string): Date | undefined {
  if (!iso) {
    return undefined;
  }
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return undefined;
  }
  return new Date(y, m - 1, d);
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const labelFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatRange(start: string, end: string): string {
  const a = isoToDate(start);
  const b = isoToDate(end);
  if (!a || !b) {
    return 'Seleccionar rango';
  }
  return `${labelFmt.format(a)} – ${labelFmt.format(b)}`;
}

// Shopify-style range picker: a trigger that opens a popover with a preset
// list on the left and a two-month calendar on the right. Date math stays in
// the parent (presets are precomputed); this component only renders and stages
// the selection until "Aplicar". Shared across the dashboard and sales views.
export function DateRangePicker({
  start,
  end,
  compare,
  activePreset,
  presets,
  maxDate,
  onApply,
  showCompare = true,
  onClear,
  triggerClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>({
    from: isoToDate(start),
    to: isoToDate(end),
  });
  const [localCompare, setLocalCompare] = useState(compare);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(activePreset);

  // Re-sync staged state from props every time the popover opens.
  useEffect(() => {
    if (open) {
      setRange({ from: isoToDate(start), to: isoToDate(end) });
      setLocalCompare(compare);
      setSelectedPreset(activePreset);
    }
  }, [open, start, end, compare, activePreset]);

  const maxDateObj = isoToDate(maxDate);

  function choosePreset(p: PresetOption) {
    setRange({ from: isoToDate(p.range.start), to: isoToDate(p.range.end) });
    setSelectedPreset(p.key);
  }

  function apply() {
    if (!range?.from || !range?.to) {
      return;
    }
    onApply({
      start: dateToIso(range.from),
      end: dateToIso(range.to),
      compare: localCompare,
      preset: selectedPreset,
    });
    setOpen(false);
  }

  function clear() {
    onClear?.();
    setSelectedPreset(null);
    setOpen(false);
  }

  const triggerLabel
    = (activePreset && presets.find(p => p.key === activePreset)?.label)
      || formatRange(start, end);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          className={cn(
            'h-9 justify-start overflow-hidden font-medium',
            triggerClassName,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[95vw] p-0">
        <div className="
          flex flex-col
          sm:flex-row
        "
        >
          <div className="
            flex flex-row flex-wrap gap-1 border-b p-2
            sm:flex-col sm:border-r sm:border-b-0
          "
          >
            {presets.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => choosePreset(p)}
                className={cn(
                  `
                    rounded-md px-3 py-1.5 text-left text-sm font-medium
                    transition-colors
                  `,
                  selectedPreset === p.key
                    ? 'bg-primary/10 text-primary'
                    : `
                      text-muted-foreground
                      hover:bg-accent
                    `,
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="p-2">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={range}
              onSelect={(r) => {
                setRange(r);
                setSelectedPreset(null);
              }}
              defaultMonth={range?.from ?? maxDateObj}
              disabled={maxDateObj ? { after: maxDateObj } : undefined}
            />

            <div className="
              mt-2 flex flex-wrap items-center justify-between gap-3 border-t
              pt-2
            "
            >
              <div className="flex items-center gap-3">
                {showCompare && (
                  <label className="
                    flex cursor-pointer items-center gap-2 text-sm font-medium
                  "
                  >
                    <input
                      type="checkbox"
                      checked={localCompare}
                      onChange={e => setLocalCompare(e.target.checked)}
                      className="size-4 accent-primary"
                    />
                    Comparar periodo anterior
                  </label>
                )}
                {onClear && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clear}
                  >
                    Limpiar
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={apply}
                  disabled={!range?.from || !range?.to}
                >
                  Aplicar
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
