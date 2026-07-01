import type { WompiEvent } from '@/libs/wompi/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeEventChecksum } from '@/libs/wompi/events';

// Route contract: checksum verification gates everything. A valid event
// triggers a best-effort authoritative status query (getTransaction) and then
// confirmTopUpPayment with the resolved status; an invalid checksum must
// short-circuit with 401 before confirmTopUpPayment is ever called.

const SECRET = 'test_events_secret_123';

const h = vi.hoisted(() => ({
  eventsSecret: 'test_events_secret_123' as string | undefined,
  confirmTopUpPayment: vi.fn(async () => {}),
  getTransaction: vi.fn(async () => null as { id: string; status: string; reference: string; amountInCents: number; currency: string } | null),
}));

vi.mock('@/libs/Env', () => ({
  Env: {
    get WOMPI_EVENTS_SECRET() {
      return h.eventsSecret;
    },
  },
}));

vi.mock('@/libs/wompi/client', () => ({
  getTransaction: h.getTransaction,
}));

vi.mock('@/actions/plans', () => ({
  confirmTopUpPayment: h.confirmTopUpPayment,
}));

function buildEvent(overrides: { amount_in_cents?: number; reference?: string | null } = {}): WompiEvent {
  const reference = overrides.reference === undefined ? 'topup-ref-1' : overrides.reference;
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: 'wompi-tx-1',
        status: 'APPROVED',
        reference,
        amount_in_cents: overrides.amount_in_cents ?? 1_900_000,
        currency: 'COP',
      },
    },
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: '',
    },
    timestamp: 1_234_567_890,
  };
}

function makeRequest(event: WompiEvent, checksum: string, headers: Record<string, string> = {}): Request {
  const body = { ...event, signature: { ...event.signature, checksum } };
  return new Request('http://localhost/api/webhooks/wompi', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.eventsSecret = SECRET;
  h.confirmTopUpPayment.mockClear();
  h.getTransaction.mockClear();
  h.getTransaction.mockResolvedValue(null);
});

describe('POST /api/webhooks/wompi', () => {
  it('valid checksum → 200 and confirmTopUpPayment called with (reference, status, id)', async () => {
    const event = buildEvent();
    const checksum = computeEventChecksum(event, SECRET);

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, checksum));

    expect(res.status).toBe(200);
    expect(h.confirmTopUpPayment).toHaveBeenCalledWith(
      'topup-ref-1',
      'APPROVED',
      'wompi-tx-1',
    );
  });

  it('invalid checksum → 401, confirmTopUpPayment NOT called', async () => {
    const event = buildEvent();

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));

    expect(res.status).toBe(401);
    expect(h.confirmTopUpPayment).not.toHaveBeenCalled();
  });

  it('missing checksum entirely → 401', async () => {
    const event = buildEvent();
    const req = new Request('http://localhost/api/webhooks/wompi', {
      method: 'POST',
      body: JSON.stringify(event), // signature.checksum left as '' and no header
    });

    const { POST } = await import('./route');
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(h.confirmTopUpPayment).not.toHaveBeenCalled();
  });

  it('accepts the checksum via the X-Event-Checksum header when the body omits it', async () => {
    const event = buildEvent();
    const checksum = computeEventChecksum(event, SECRET);
    // Body's signature.checksum stays empty; header carries it instead.
    const req = makeRequest(event, '', { 'x-event-checksum': checksum });

    const { POST } = await import('./route');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(h.confirmTopUpPayment).toHaveBeenCalledWith(
      'topup-ref-1',
      'APPROVED',
      'wompi-tx-1',
    );
  });

  it('uses the authoritative getTransaction status over the webhook body when available', async () => {
    const event = buildEvent();
    const checksum = computeEventChecksum(event, SECRET);
    h.getTransaction.mockResolvedValue({
      id: 'wompi-tx-1',
      status: 'DECLINED',
      reference: 'topup-ref-1',
      amountInCents: 1_900_000,
      currency: 'COP',
    });

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, checksum));

    expect(res.status).toBe(200);
    expect(h.confirmTopUpPayment).toHaveBeenCalledWith(
      'topup-ref-1',
      'DECLINED',
      'wompi-tx-1',
    );
  });

  it('non transaction.updated events → 200, ignored, confirmTopUpPayment NOT called', async () => {
    const event = { ...buildEvent(), event: 'nequi_token.updated' };
    const checksum = computeEventChecksum(event, SECRET);

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, checksum));

    expect(res.status).toBe(200);
    expect(h.confirmTopUpPayment).not.toHaveBeenCalled();
  });

  it('WOMPI_EVENTS_SECRET unset → 503, nothing processed', async () => {
    h.eventsSecret = undefined;
    const event = buildEvent();

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, 'irrelevant'));

    expect(res.status).toBe(503);
    expect(h.confirmTopUpPayment).not.toHaveBeenCalled();
  });

  it('malformed JSON body → 400', async () => {
    const req = new Request('http://localhost/api/webhooks/wompi', {
      method: 'POST',
      body: '{not json',
    });

    const { POST } = await import('./route');
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('a thrown error from confirmTopUpPayment → 500 (so Wompi retries)', async () => {
    const event = buildEvent();
    const checksum = computeEventChecksum(event, SECRET);
    h.confirmTopUpPayment.mockRejectedValueOnce(new Error('db unavailable'));

    const { POST } = await import('./route');
    const res = await POST(makeRequest(event, checksum));

    expect(res.status).toBe(500);
  });
});
