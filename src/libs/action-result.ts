/**
 * Shared result contract for Server Actions consumed by client components.
 *
 * Production Next.js masks thrown errors from Server Actions behind a generic
 * digest, so user-facing validation must be RETURNED, not thrown, to reach the
 * UI. Throw `ActionValidationError` for expected validation (inside transactions
 * it still triggers rollback), catch it at the action boundary, and convert it
 * to `{ ok: false, error }`. Let genuinely unexpected errors keep throwing —
 * those are real 500s and should surface in logs/Sentry.
 */
export type ActionResult<T>
  = | { ok: true; data: T }
    | {
      ok: false;
      error: string;
      /** Optional machine-readable code so the UI can branch (e.g. show a CTA). */
      code?: string;
      /** Optional structured payload that accompanies a coded failure. */
      meta?: Record<string, unknown>;
    };

/** Expected, user-facing validation failure. */
export class ActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionValidationError';
  }
}

/** Postgres unique_violation — e.g. a concurrent insert racing a unique index. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '23505'
  );
}
