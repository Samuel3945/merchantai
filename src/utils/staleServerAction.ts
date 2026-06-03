// After a deploy, browser tabs opened against the previous build still hold a
// client bundle whose Server Action IDs no longer exist on the new server.
// Next.js then throws "Server Action ... was not found on the server". The fix
// is to reload once so the browser fetches the fresh bundle — but only ONCE,
// because a *permanent* mismatch (e.g. multiple replicas with different
// server-action encryption keys) would otherwise trap the user in a reload loop.

const STALE_ACTION_PATTERN
  = /Server Action.+was not found on the server|Failed to find Server Action|from an older or newer deployment/i;

const RELOAD_GUARD_KEY = 'pos:stale-action-reloaded-at';
// If the same error reappears within this window after a reload, treat it as
// permanent and stop reloading so the real error can surface.
const RELOAD_GUARD_WINDOW_MS = 15_000;

export function isStaleServerActionError(error: unknown): boolean {
  const message
    = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return STALE_ACTION_PATTERN.test(message);
}

/**
 * Reload the page to pick up the fresh client bundle after a deploy.
 * Returns `true` if a reload was triggered, `false` if the guard blocked it
 * (meaning the error already came back after a recent reload — likely
 * permanent, so the caller should surface the error instead).
 */
export function reloadForStaleServerAction(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const last = Number(
      window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0',
    );
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_WINDOW_MS) {
      return false;
    }
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode) — fall through and reload once.
  }

  window.location.reload();
  return true;
}
