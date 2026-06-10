'use client';

import * as React from 'react';

type ConfirmTone = 'default' | 'destructive';

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  // 'destructive' paints the confirm button red and swaps the icon — use it for
  // irreversible actions (delete). Reversible ones (archive) keep 'default'.
  tone?: ConfirmTone;
};

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirmation. Replaces the native `window.confirm` so every
 * confirmation shares one themed, accessible dialog instead of the browser's
 * unstyled box. Usage:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: '…', tone: 'destructive' }))) return;
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.use(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a <ConfirmProvider>');
  }
  return ctx;
}
