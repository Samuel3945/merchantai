'use client';

import { Check, Minus } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/utils/Helpers';

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        `
          peer size-[18px] shrink-0 cursor-pointer rounded-[5px] border
          border-input bg-background shadow-xs transition-colors outline-none
          hover:border-primary/70
          focus-visible:ring-2 focus-visible:ring-ring/50
          disabled:cursor-not-allowed disabled:opacity-50
          data-[state=checked]:border-primary data-[state=checked]:bg-primary
          data-[state=checked]:text-primary-foreground
          data-[state=indeterminate]:border-primary
          data-[state=indeterminate]:bg-primary
          data-[state=indeterminate]:text-primary-foreground
        `,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="
          flex items-center justify-center text-current
          data-[state=checked]:animate-in data-[state=checked]:zoom-in-50
        "
      >
        {props.checked === 'indeterminate'
          ? <Minus className="size-3.5" strokeWidth={3} />
          : <Check className="size-3.5" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
