// Client-safe constants for the transfer-investigation org settings.
//
// These live OUTSIDE transfer-reconciliation.ts on purpose: that module imports
// the DB (pg) and Clerk's server-only auth, so importing anything from it into a
// client component drags server-only code (and pg's node built-ins) into the
// browser bundle and breaks the Turbopack production build. Client components
// must import these keys from here instead.

/** Setting key for toggle A (block close when open investigations exist). */
export const BLOCK_CLOSE_SETTING_KEY = 'transfer-block-close-on-investigation';

/** Setting key for toggle B (default destination for a non-arrival). */
export const DEFAULT_RESOLUTION_SETTING_KEY = 'transfer-default-resolution';
