'use client';

import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/utils/Helpers';

type Props = {
  /** ISO 'YYYY-MM-DD' or '' when no date is selected. */
  value: string;
  onChange: (iso: string) => void;
  /** Earliest selectable day (ISO). Days before it are disabled. */
  min?: string;
  placeholder?: string;
  /** Extra classes for the trigger button (e.g. "w-full"). */
  triggerClassName?: string;
};

// ISO 'YYYY-MM-DD' <-> local Date, kept TZ-neutral so the calendar shows the
// same calendar day the string encodes (no UTC drift). Mirrors DateRangePicker.
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
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

// Single-day picker: a trigger button that opens a one-month calendar in a
// popover. Same visual language as DateRangePicker, used for fields that need
// one date (e.g. lot expiry). Replaces the native <input type="date">.
export function DatePicker({
  value,
  onChange,
  min,
  placeholder = 'Elegir fecha',
  triggerClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = isoToDate(value);
  const minDate = isoToDate(min);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          className={cn(
            'h-9 justify-start gap-2 overflow-hidden font-medium',
            !selected && 'text-muted-foreground',
            triggerClassName,
          )}
        >
          <CalendarDays className="size-4 shrink-0 opacity-70" />
          <span className="truncate">
            {selected ? labelFmt.format(selected) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            if (d) {
              onChange(dateToIso(d));
              setOpen(false);
            }
          }}
          defaultMonth={selected ?? minDate}
          disabled={minDate ? { before: minDate } : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}
