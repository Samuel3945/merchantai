'use client';

import type { ConfirmOptions } from './confirm';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/utils/Helpers';
import { Button } from './button';
import { ConfirmContext } from './confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  // Kept rendered through the close animation so the dialog never loses its
  // title mid-exit; replaced on the next confirm().
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const resolverRef = React.useRef<((result: boolean) => void) | null>(null);

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = React.useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOpen(false);
  }, []);

  const destructive = options?.tone === 'destructive';
  const Icon = destructive ? AlertTriangle : HelpCircle;

  return (
    <ConfirmContext value={confirm}>
      {children}
      <Dialog open={open} onOpenChange={next => !next && settle(false)}>
        {options && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    `
                      mt-0.5 flex size-9 shrink-0 items-center justify-center
                      rounded-full
                    `,
                    destructive
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-primary/10 text-primary',
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <div className="space-y-1">
                  <DialogTitle>{options.title}</DialogTitle>
                  {options.description && (
                    <DialogDescription className="whitespace-pre-line">
                      {options.description}
                    </DialogDescription>
                  )}
                </div>
              </div>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => settle(false)}>
                {options.cancelText ?? 'Cancelar'}
              </Button>
              <Button
                variant={destructive ? 'destructive' : 'default'}
                onClick={() => settle(true)}
              >
                {options.confirmText ?? 'Aceptar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext>
  );
}
