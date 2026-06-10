'use client';

import type { LucideIcon } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

type ProductTypeToggle = {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

// Centered settings-style card grouping the product's commercial type flags
// ("Por mayor", "Se vence"). Each flag is an INDEPENDENT boolean rendered as a
// labelled row with a switch on the right — never a segmented control, because a
// product can be both, one, or neither. Renders nothing when no toggle applies
// (feature flags off, or perishable hidden while editing), so callers can drop
// it in unconditionally.
export function ProductTypeToggles({ rows }: { rows: ProductTypeToggle[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      {rows.map((row, i) => {
        const Icon = row.icon;
        return (
          <div key={row.id}>
            {i > 0 && <Separator />}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="
                flex size-9 shrink-0 items-center justify-center rounded-md
                bg-background text-muted-foreground
              "
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{row.label}</p>
                <p className="text-xs text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                id={row.id}
                checked={row.checked}
                onCheckedChange={row.onCheckedChange}
                aria-label={row.label}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
