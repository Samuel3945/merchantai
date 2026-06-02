'use client';

import { cn } from '@/utils/Helpers';

type SwitchProps = {
  'checked': boolean;
  'onCheckedChange': (checked: boolean) => void;
  'disabled'?: boolean;
  'id'?: string;
  'className'?: string;
  'aria-label'?: string;
};

// Toggle booleano accesible (role="switch"). Reemplaza los <input type="checkbox">
// crudos en Configuración por un control on/off consistente en toda la app.
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        `
          relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center
          rounded-full transition-colors outline-none
          focus-visible:ring-2 focus-visible:ring-ring/50
          disabled:cursor-not-allowed disabled:opacity-50
        `,
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
    >
      <span
        className={cn(
          `
            pointer-events-none inline-block size-4 rounded-full bg-background
            shadow-sm transition-transform
          `,
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
