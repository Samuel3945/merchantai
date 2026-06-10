'use client';

import { CalendarDays, ChevronLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
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

type Step = 'year' | 'month' | 'day';

// How many years to offer in the year grid (4 cols x 4 rows). Generous enough
// for any perishable while keeping the step grid compact.
const YEAR_SPAN = 16;

// ISO 'YYYY-MM-DD' <-> local Date, kept TZ-neutral so the picker shows the same
// calendar day the string encodes (no UTC drift). Mirrors DateRangePicker.
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

function dateToIso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const labelFmt = new Intl.DateTimeFormat('es-CO', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const monthFmt = new Intl.DateTimeFormat('es-CO', { month: 'short' });
const monthNames = Array.from({ length: 12 }, (_, m) =>
  monthFmt.format(new Date(2000, m, 1)).replace('.', ''));
const longMonthFmt = new Intl.DateTimeFormat('es-CO', { month: 'long' });

// Monday-first weekday headers for the day grid.
const weekdayLabels = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Leading blank cells so day 1 lands under its weekday (Monday-first).
function leadingBlanks(year: number, month: number): number {
  return (new Date(year, month, 1).getDay() + 6) % 7;
}

const cellBase
  = 'flex items-center justify-center rounded-md text-sm font-medium '
    + 'transition-colors hover:bg-accent hover:text-accent-foreground '
    + 'focus-visible:outline-none focus-visible:ring-2 '
    + 'focus-visible:ring-ring';

// Stepped single-day picker: pick year, then month, then day. Each step has a
// back arrow so a wrong tap is one click away from undo. Built for lot expiry,
// where the target date is usually months or years ahead and a month-by-month
// calendar is slower than jumping straight to the year. Same trigger + popover
// visual language as the rest of the app. Replaces <input type="date">.
export function DatePicker({
  value,
  onChange,
  min,
  placeholder = 'Elegir fecha',
  triggerClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('year');
  const [draftYear, setDraftYear] = useState<number | null>(null);
  const [draftMonth, setDraftMonth] = useState<number | null>(null);

  const selected = isoToDate(value);
  const minDate = useMemo(() => isoToDate(min), [min]);

  // Restart the flow at the year step whenever the popover opens, seeding the
  // draft from the current value so the existing pick stays highlighted. Done
  // in the open handler (not an effect) so it runs once per toggle.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setStep('year');
      setDraftYear(selected ? selected.getFullYear() : null);
      setDraftMonth(selected ? selected.getMonth() : null);
    }
    setOpen(next);
  };

  const baseYear = (minDate ?? new Date()).getFullYear();
  const years = Array.from({ length: YEAR_SPAN }, (_, i) => baseYear + i);

  const isMonthDisabled = (year: number, month: number) =>
    !!minDate
    && (year < minDate.getFullYear()
      || (year === minDate.getFullYear() && month < minDate.getMonth()));

  const isDayDisabled = (year: number, month: number, day: number) =>
    !!minDate && new Date(year, month, day) < minDate;

  const headerTitle
    = step === 'year'
      ? 'Elegí el año'
      : step === 'month'
        ? String(draftYear)
        : `${longMonthFmt.format(new Date(draftYear ?? 2000, draftMonth ?? 0, 1))} ${draftYear}`;

  const goBack = () => {
    if (step === 'day') {
      setStep('month');
    } else if (step === 'month') {
      setStep('year');
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
      <PopoverContent align="start" className="w-68 p-2">
        {/* Step header: back arrow (hidden on the first step) + current crumb */}
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 'year'}
            aria-label="Volver"
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-md',
              `
                transition-colors
                hover:bg-accent hover:text-accent-foreground
              `,
              step === 'year' && 'pointer-events-none opacity-0',
            )}
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="flex-1 text-center text-sm font-semibold capitalize">
            {headerTitle}
          </span>
          {/* Spacer to keep the crumb centered against the back arrow. */}
          <span className="size-7 shrink-0" />
        </div>

        {step === 'year' && (
          <div className="grid grid-cols-4 gap-1">
            {years.map(y => (
              <button
                key={y}
                type="button"
                onClick={() => {
                  setDraftYear(y);
                  setStep('month');
                }}
                className={cn(
                  cellBase,
                  'h-10',
                  selected?.getFullYear() === y
                  && `
                    bg-primary text-primary-foreground
                    hover:bg-primary
                  `,
                )}
              >
                {y}
              </button>
            ))}
          </div>
        )}

        {step === 'month' && draftYear !== null && (
          <div className="grid grid-cols-3 gap-1">
            {monthNames.map((name, m) => {
              const disabled = isMonthDisabled(draftYear, m);
              const isSel
                = selected?.getFullYear() === draftYear
                  && selected?.getMonth() === m;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setDraftMonth(m);
                    setStep('day');
                  }}
                  className={cn(
                    cellBase,
                    'h-10 capitalize',
                    isSel && `
                      bg-primary text-primary-foreground
                      hover:bg-primary
                    `,
                    disabled && 'pointer-events-none opacity-40',
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}

        {step === 'day' && draftYear !== null && draftMonth !== null && (
          <div>
            <div className="mb-1 grid grid-cols-7 gap-1">
              {weekdayLabels.map(w => (
                <span
                  key={w}
                  className="
                    flex h-6 items-center justify-center text-[11px] font-medium
                    text-muted-foreground
                  "
                >
                  {w}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: leadingBlanks(draftYear, draftMonth) }).map(
                (_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <span key={`blank-${i}`} />
                ),
              )}
              {Array.from(
                { length: daysInMonth(draftYear, draftMonth) },
                (_, i) => i + 1,
              ).map((day) => {
                const disabled = isDayDisabled(draftYear, draftMonth, day);
                const isSel
                  = selected?.getFullYear() === draftYear
                    && selected?.getMonth() === draftMonth
                    && selected?.getDate() === day;
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onChange(dateToIso(draftYear, draftMonth, day));
                      setOpen(false);
                    }}
                    className={cn(
                      cellBase,
                      'size-9',
                      isSel
                      && `
                        bg-primary text-primary-foreground
                        hover:bg-primary
                      `,
                      disabled && 'pointer-events-none opacity-40',
                    )}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
