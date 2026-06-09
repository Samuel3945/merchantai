// Global toast store (sonner-style). Lives in a non-component module so the
// <Toaster /> file can stay component-only for React Fast Refresh. Any component
// can call `toast(...)` without threading a context.

export type ToastVariant = 'default' | 'success' | 'error';

export type ToastInput = {
  title?: string;
  description: string;
  variant?: ToastVariant;
};

export type ToastItem = ToastInput & { id: number; variant: ToastVariant };

let counter = 0;
const listeners = new Set<(t: ToastItem) => void>();

function emit(input: ToastInput): void {
  counter += 1;
  const item: ToastItem = {
    id: counter,
    title: input.title,
    description: input.description,
    variant: input.variant ?? 'default',
  };
  for (const l of listeners) {
    l(item);
  }
}

export const toast = Object.assign(emit, {
  success: (description: string, title?: string) =>
    emit({ description, title, variant: 'success' }),
  error: (description: string, title?: string) =>
    emit({ description, title, variant: 'error' }),
});

export function subscribeToasts(fn: (t: ToastItem) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
