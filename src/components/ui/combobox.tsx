'use client';

import type { SelectOption } from './select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/utils/Helpers';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

// cmdk needs a non-empty, unique value per item for keyboard nav and selection.
// The app uses '' for the "all / no filter" option, so map it to a sentinel for
// cmdk only — selection still reports the real option value via the closure.
const EMPTY_CMDK_VALUE = '__combobox_empty__';

/**
 * Searchable single-select (autocomplete). Same ergonomic API as `Select`, so a
 * native select / `Select` can be swapped for it when the option list is long
 * enough that scrolling a plain dropdown is painful (e.g. products, or
 * suppliers past a threshold). Closed, its trigger is visually identical to a
 * `Select` trigger; open, it adds a type-to-filter input.
 */
function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Seleccionar',
  searchPlaceholder = 'Buscar...',
  emptyText = 'Sin resultados',
  className,
  id,
  disabled,
  'aria-label': ariaLabel,
}: {
  'value': string;
  'onValueChange': (value: string) => void;
  'options': SelectOption[];
  'placeholder'?: string;
  'searchPlaceholder'?: string;
  'emptyText'?: string;
  'className'?: string;
  'id'?: string;
  'disabled'?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find(option => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          data-slot="combobox-trigger"
          className={cn(
            `
              flex h-9 w-full items-center justify-between gap-2 rounded-lg
              border border-input bg-muted px-3 py-1 text-sm shadow-xs
              transition-colors outline-none
              hover:bg-muted/70
              focus-visible:ring-2 focus-visible:ring-ring/50
              disabled:cursor-not-allowed disabled:opacity-50
            `,
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="line-clamp-1 text-left">
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const labelText
                  = typeof option.label === 'string'
                    ? option.label
                    : String(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value === '' ? EMPTY_CMDK_VALUE : option.value}
                    keywords={[labelText]}
                    disabled={option.disabled}
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="line-clamp-1">{option.label}</span>
                    <CheckIcon
                      className={cn(
                        'ml-auto size-4 text-brand',
                        option.value === value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };
