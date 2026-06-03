'use client';

import { useEffect } from 'react';
import {
  isStaleServerActionError,
  reloadForStaleServerAction,
} from '@/utils/staleServerAction';

/**
 * Mounted once in the root layout. Catches the "Server Action was not found"
 * failure that hits browser tabs left open across a deploy, and reloads to
 * fetch the fresh bundle — so the user never sees the raw error.
 *
 * Covers async event handlers that don't catch the error themselves (they
 * surface as unhandled rejections / window errors). Handlers that DO catch it
 * — e.g. useSettingSave — call the same helper directly.
 */
export function StaleActionReloader() {
  useEffect(() => {
    function onRejection(event: PromiseRejectionEvent) {
      if (isStaleServerActionError(event.reason)) {
        reloadForStaleServerAction();
      }
    }
    function onError(event: ErrorEvent) {
      if (isStaleServerActionError(event.error ?? event.message)) {
        reloadForStaleServerAction();
      }
    }
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  return null;
}
