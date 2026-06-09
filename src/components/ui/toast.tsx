'use client';

import type { ToastItem, ToastVariant } from '@/components/ui/toast-store';
import { CheckCircle2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';
import { subscribeToasts } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';

const VARIANT_STYLES: Record<ToastVariant, string> = {
  default: 'border-border',
  success: 'border-success/40',
  error: 'border-destructive/40',
};

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  default: null,
  success: <CheckCircle2Icon className="size-4 text-success" />,
  error: <TriangleAlertIcon className="size-4 text-destructive" />,
};

// Single mounted instance per page renders every queued toast.
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToasts(t => setItems(prev => [...prev, t]));
  }, []);

  function remove(id: number) {
    setItems(prev => prev.filter(i => i.id !== id));
  }

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
      {items.map(item => (
        <ToastPrimitive.Root
          key={item.id}
          onOpenChange={(open) => {
            if (!open) {
              remove(item.id);
            }
          }}
          className={cn(
            `
              flex items-start gap-3 rounded-md border bg-background p-4
              shadow-lg
              data-[state=closed]:animate-out data-[state=closed]:fade-out-80
              data-[state=open]:animate-in
              data-[state=open]:slide-in-from-right-full
              data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80
            `,
            VARIANT_STYLES[item.variant],
          )}
        >
          {VARIANT_ICON[item.variant]}
          <div className="flex-1 space-y-1">
            {item.title && (
              <ToastPrimitive.Title className="text-sm font-semibold">
                {item.title}
              </ToastPrimitive.Title>
            )}
            <ToastPrimitive.Description className="
              text-sm text-muted-foreground
            "
            >
              {item.description}
            </ToastPrimitive.Description>
          </div>
          <ToastPrimitive.Close
            className="
              text-muted-foreground opacity-70 transition-opacity
              hover:opacity-100
            "
            aria-label="Cerrar"
          >
            <XIcon className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className="
          fixed right-0 bottom-0 z-100 flex max-h-screen w-full flex-col gap-2
          p-4
          sm:max-w-sm
        "
      />
    </ToastPrimitive.Provider>
  );
}
