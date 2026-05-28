import { NextResponse } from 'next/server';
import { getUnreadCount, listNotifications } from '@/actions/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);

  try {
    const [items, unreadCount] = await Promise.all([
      listNotifications({ unreadOnly, limit }),
      getUnreadCount(),
    ]);
    return NextResponse.json({ ok: true, items, unreadCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    const status = message === 'Not authenticated' || message === 'No active organization' ? 401 : 500;
    return NextResponse.json({ ok: false, reason: message }, { status });
  }
}
