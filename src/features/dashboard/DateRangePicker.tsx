'use client';

import type { DateRange } from 'react-day-picker';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/utils/Helpers';

export type PresetOption = {
  key: string;
  label: string;
  range: { start: string; end: string };
};

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
// list on the left and a two-month calendar on the right, plus a compare
// toggle. Date math stays in the parent (presets are precomputed); this
// component only renders and stages the selection until "Aplicar".
export function DateRangePicker({
  start,
  end,
  compare,
  activePreset,
  presets,
  maxDate,
  onApply,
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

  const triggerLabel
    = (activePreset && presets.find(p => p.key === activePreset)?.label)
      || formatRange(start, end);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          className="h-9 justify-start gap-2 font-medium"
        >
          <span aria-hidden>🗓</span>
          {triggerLabel}
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
