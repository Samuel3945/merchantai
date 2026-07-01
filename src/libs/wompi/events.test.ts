import type { WompiEvent } from './events';
import { describe, expect, it } from 'vitest';
import { computeEventChecksum, resolveDotPath, verifyEventChecksum } from './events';

// Known-answer vector taken verbatim from the "Paso a paso" worked example on
// docs.wompi.co/docs/colombia/eventos.
//
// GOTCHA (verified against the live docs page, not just memory): Wompi's own
// docs place `timestamp` at the TOP LEVEL of the event body, as a sibling of
// `signature` — NOT nested inside `signature` as originally assumed. The
// event shape below (`WompiEvent`) reflects the real, documented contract.
//
// GOTCHA #2: the docs' own printed checksum for this example
// ("3476DDA50F64CD7CBD160689640506FEBEA93239BC524FC0469B2C68A3CC8BD0") does
// NOT actually verify — SHA256 of their own literal concatenated string
// ("1234-1610641025-49201APPROVED44900001530291411prod_events_...") computes
// to the value asserted below instead. Cross-checked against sha1/sha224/
// sha384/sha512/md5/sha3-256/sha512-256 to rule out a mislabeled algorithm —
// none match either. This looks like a stale example in Wompi's docs (the
// concatenation algorithm they describe is otherwise unambiguous and is what
// this module implements — it's what Wompi's real servers will compute for
// real webhooks). See engram discovery notes for this project.
const SECRET = 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z';
const CORRECTED_CHECKSUM
  = '5a18ec5e8fdb7df463e9f94774cba8f583ba21bd04a09ceff2ea68a4bc0aefbe';

function buildEvent(amountInCents = 4_490_000): WompiEvent {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-1610641025-49201',
        status: 'APPROVED',
        amount_in_cents: amountInCents,
      },
    },
    signature: {
      properties: [
        'transaction.id',
        'transaction.status',
        'transaction.amount_in_cents',
      ],
      checksum: CORRECTED_CHECKSUM,
    },
    timestamp: 1_530_291_411,
    sent_at: '2018-07-20T16:45:05.000Z',
  };
}

describe('resolveDotPath', () => {
  it('resolves a nested dot path', () => {
    expect(resolveDotPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined when an intermediate segment is missing', () => {
    expect(resolveDotPath({ a: {} }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when the root is not an object', () => {
    expect(resolveDotPath(null, 'a.b')).toBeUndefined();
    expect(resolveDotPath('x', 'a.b')).toBeUndefined();
  });
});

describe('computeEventChecksum', () => {
  it('matches the corrected known-answer vector', () => {
    expect(computeEventChecksum(buildEvent(), SECRET).toLowerCase()).toBe(
      CORRECTED_CHECKSUM,
    );
  });
});

describe('verifyEventChecksum', () => {
  it('returns true for the correct checksum, case-insensitively', () => {
    expect(verifyEventChecksum(buildEvent(), SECRET, CORRECTED_CHECKSUM)).toBe(
      true,
    );
    expect(
      verifyEventChecksum(
        buildEvent(),
        SECRET,
        CORRECTED_CHECKSUM.toUpperCase(),
      ),
    ).toBe(true);
  });

  it('returns false when the payload was tampered with', () => {
    const tampered = buildEvent(999);

    expect(verifyEventChecksum(tampered, SECRET, CORRECTED_CHECKSUM)).toBe(
      false,
    );
  });

  it('returns false for a garbage/short checksum', () => {
    expect(verifyEventChecksum(buildEvent(), SECRET, 'not-a-hash')).toBe(
      false,
    );
  });

  it('returns false when the secret is wrong', () => {
    expect(
      verifyEventChecksum(buildEvent(), 'wrong-secret', CORRECTED_CHECKSUM),
    ).toBe(false);
  });
});
