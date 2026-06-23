// Canonical UUID (any version) format check. Used to gate values before they
// reach a Postgres `uuid` column: a present-but-malformed value would throw
// 22P02 (invalid input syntax for type uuid) on the query, so callers normalize
// a malformed value to null instead of crashing the request.
const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Returns the trimmed value when it is a well-formed UUID, otherwise null.
 * A null/empty/whitespace value yields null (absent). A non-UUID string also
 * yields null (back-compat: no dedupe, normal create) — never a thrown 22P02.
 */
export function normalizeIdempotencyKey(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim() || null;
  if (!trimmed) {
    return null;
  }
  return isUuid(trimmed) ? trimmed : null;
}
