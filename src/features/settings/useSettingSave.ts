'use client';

import { useCallback, useRef, useState } from 'react';
import { setAppSetting } from '@/actions/app-settings';
import { useSettingsToast } from './useSettingsToast';

type SaveOptions = {
  // Debounce in ms before persisting. 0 = save immediately on blur/change.
  debounceMs?: number;
  // Fire window.dispatchEvent('pos:app-config:changed') after a successful save.
  notifyConfigChange?: boolean;
  // Toast message to show on success. Defaults to "Guardado".
  successMessage?: string;
};

export function useSettingSave() {
  const toast = useSettingsToast();
  const [saving, setSaving] = useState(false);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const persist = useCallback(
    async (key: string, value: string, opts?: SaveOptions) => {
      setSaving(true);
      try {
        await setAppSetting(key, value);
        toast.show(opts?.successMessage ?? 'Guardado', 'success');
        if (opts?.notifyConfigChange && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('pos:app-config:changed', {
            detail: { key, value },
          }));
        }
      } catch (e) {
        toast.show(
          e instanceof Error ? e.message : 'No se pudo guardar',
          'error',
        );
        throw e;
      } finally {
        setSaving(false);
      }
    },
    [toast],
  );

  const save = useCallback(
    (key: string, value: string, opts?: SaveOptions): Promise<void> => {
      const debounce = opts?.debounceMs ?? 0;
      const existing = timers.current.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      if (debounce === 0) {
        return persist(key, value, opts);
      }
      return new Promise<void>((resolve, reject) => {
        const handle = setTimeout(() => {
          timers.current.delete(key);
          persist(key, value, opts).then(resolve, reject);
        }, debounce);
        timers.current.set(key, handle);
      });
    },
    [persist],
  );

  return { save, saving };
}
