'use client';

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/utils/Helpers';

// Radix forbids a <Select.Item> with an empty-string value. The app uses '' to
// mean "no filter / all". Map '' to this private sentinel so call sites keep
// using '' for both the value and the option, with no change to their data.
const EMPTY_VALUE = '__select_empty__';

function toInternal(value: string): string {
  return value === '' ? EMPTY_VALUE : value;
}

function fromInternal(value: string): string {
  return value === EMPTY_VALUE ? '' : value;
}

function SelectRoot(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        `
          flex h-9 w-full items-center justify-between gap-2 rounded-lg border
          border-input bg-muted px-3 py-1 text-sm shadow-xs transition-colors
          outline-none
          hover:bg-muted/70
          focus-visible:ring-2 focus-visible:ring-ring/50
          disabled:cursor-not-allowed disabled:opacity-50
          data-placeholder:text-muted-foreground
          *:data-[slot=select-value]:line-clamp-1
          *:data-[slot=select-value]:text-left
          [&_svg]:pointer-events-none [&_svg]:shrink-0
        `,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUpIcon className="size-4 opacity-60" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDownIcon className="size-4 opacity-60" />
    </SelectPrimitive.ScrollDownButton>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          `
            relative z-50 max-h-(--radix-select-content-available-height)
            min-w-32 overflow-x-hidden overflow-y-auto rounded-lg border
            bg-popover p-1 text-popover-foreground shadow-md
            data-[side=bottom]:slide-in-from-top-2
            data-[side=top]:slide-in-from-bottom-2
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            data-[state=closed]:zoom-out-95
            data-[state=open]:animate-in data-[state=open]:fade-in-0
            data-[state=open]:zoom-in-95
          `,
          position === 'popper'
          && 'min-w-(--radix-select-trigger-width)',
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-0">
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-3 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        `
          relative flex w-full cursor-pointer items-center rounded-md py-2 pr-8
          pl-3 text-sm outline-none select-none
          data-disabled:pointer-events-none data-disabled:opacity-50
          data-highlighted:bg-brand/10 data-highlighted:text-foreground
          data-[state=checked]:font-medium
        `,
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-brand" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

/**
 * Ergonomic wrapper over the Radix Select primitives for the common case: a
 * controlled value plus a flat list of options. Keeps the empty-string ('')
 * convention used across the app for "all / no filter" — it is mapped to an
 * internal sentinel so Radix accepts it. For grouped or custom content, compose
 * the exported primitives directly.
 */
function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  id,
  name,
  'aria-label': ariaLabel,
}: {
  'value': string;
  'onValueChange': (value: string) => void;
  'options': SelectOption[];
  'placeholder'?: string;
  'disabled'?: boolean;
  'className'?: string;
  'id'?: string;
  'name'?: string;
  'aria-label'?: string;
}) {
  return (
    <SelectRoot
      value={toInternal(value)}
      onValueChange={next => onValueChange(fromInternal(next))}
      disabled={disabled}
      name={name}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem
            key={option.value}
            value={toInternal(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
