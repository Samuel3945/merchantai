// Canonical UUID (any version) format check. Used to gate values before they
// reach a Postgres `uuid` column: a present-but-malformed value would throw
// 22P02 (invalid input syntax for type uuid) on the query, so callers normalize
// a malformed value to null instead of crashing the request.
const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The nil UUID is syntactically valid but semantically empty — never a real
// device-generated idempotency key. Treating it as one would collapse every
// "no key" sale from a buggy client into a single sale_idempotency_key, so all
// of them but the first would dedupe into the first sale.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Returns the trimmed value when it is a well-formed UUID (any version),
 * otherwise null. A null/empty/whitespace value yields null (absent). A non-UUID
 * string also yields null (back-compat: no dedupe, normal create) — never a
 * thrown 22P02. The nil UUID is rejected too: it is a placeholder, not a real
 * key, so it falls back to a normal create instead of deduping unrelated sales.
 */
export function normalizeIdempotencyKey(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim() || null;
  if (!trimmed) {
    return null;
  }
  if (trimmed === NIL_UUID) {
    return null;
  }
  return isUuid(trimmed) ? trimmed : null;
}
