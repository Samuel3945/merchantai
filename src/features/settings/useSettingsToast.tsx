'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ToastTone = 'success' | 'error';

type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
};

type ToastContextValue = {
  show: (message: string, tone?: ToastTone) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function SettingsToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    counter.current += 1;
    const id = counter.current;
    setToasts(prev => [...prev, { id, tone, message }]);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="
        pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2
      "
      >
        {toasts.map(t => (
          <ToastItem
            key={t.id}
            toast={t}
            onDone={() =>
              setToasts(prev => prev.filter(x => x.id !== t.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2400);
    return () => clearTimeout(timer);
  }, [onDone]);

  const base
    = 'pointer-events-auto rounded-md border px-4 py-2 text-sm shadow-md transition-opacity';
  const tone
    = toast.tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100'
      : 'border-destructive/40 bg-destructive/10 text-destructive';

  return (
    <div className={`
      ${base}
      ${tone}
    `}
    >
      {toast.message}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettingsToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useSettingsToast must be used inside SettingsToastProvider');
  }
  return ctx;
}
