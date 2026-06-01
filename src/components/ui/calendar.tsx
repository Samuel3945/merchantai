'use client';

import type { ComponentProps, CSSProperties } from 'react';
import { DayPicker } from 'react-day-picker';
import { cn } from '@/utils/Helpers';
import 'react-day-picker/style.css';

export type CalendarProps = ComponentProps<typeof DayPicker>;

// Thin wrapper over react-day-picker (v10). Base layout comes from the library
// stylesheet; the brand accent is mapped to the app's --primary token.
export function Calendar({ className, style, ...props }: CalendarProps) {
  return (
    <DayPicker
      className={cn('text-sm', className)}
      style={{
        '--rdp-accent-color': 'var(--primary)',
        '--rdp-accent-background-color': 'color-mix(in oklab, var(--primary) 12%, transparent)',
        ...style,
      } as CSSProperties}
      {...props}
    />
  );
}
