import type { WompiEvent } from '@/libs/wompi/events';
import { confirmTopUpPayment } from '@/actions/plans';
import { Env } from '@/libs/Env';
import { getTransaction } from '@/libs/wompi/client';
import { verifyEventChecksum } from '@/libs/wompi/events';

export const dynamic = 'force-dynamic';

type WompiTransactionPayload = {
  id?: unknown;
  status?: unknown;
  reference?: unknown;
};

function extractTransaction(event: WompiEvent): WompiTransactionPayload | null {
  const data = event.data as { transaction?: unknown } | undefined;
  const tx = data?.transaction;
  return tx && typeof tx === 'object' ? (tx as WompiTransactionPayload) : null;
}

export async function POST(req: Request) {
  if (!Env.WOMPI_EVENTS_SECRET) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const raw = await req.text();
  let event: WompiEvent;
  try {
    event = JSON.parse(raw) as WompiEvent;
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const provided = event.signature?.checksum || req.headers.get('x-event-checksum');
  if (!provided || !verifyEventChecksum(event, Env.WOMPI_EVENTS_SECRET, provided)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Only transaction lifecycle events matter for top-ups; ack everything else.
  if (event.event !== 'transaction.updated') {
    return Response.json({ ok: true, ignored: true });
  }

  const tx = extractTransaction(event);
  const reference = typeof tx?.reference === 'string' ? tx.reference : null;
  if (!tx || !reference) {
    return Response.json({ ok: true, ignored: 'no_reference' });
  }

  try {
    let status = typeof tx.status === 'string' ? tx.status : 'PENDING';
    const wompiTransactionId = typeof tx.id === 'string' ? tx.id : null;

    // Best-effort authoritative confirmation: prefer a fresh server-to-server
    // status over the (checksum-verified, but still self-reported) webhook
    // body. A failure here just falls back to the webhook's own status.
    if (wompiTransactionId) {
      try {
        const confirmed = await getTransaction(wompiTransactionId);
        if (confirmed) {
          status = confirmed.status;
        }
      } catch {
        // Keep the webhook-reported status.
      }
    }

    await confirmTopUpPayment(reference, status, wompiTransactionId);

    return Response.json({ ok: true });
  } catch {
    // Let Wompi retry a genuine failure (it retries non-200 responses).
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
