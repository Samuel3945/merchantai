import { NextResponse } from 'next/server';
import { runNotificationScan } from '@/actions/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: 'cron_secret_not_configured' },
      { status: 500 },
    );
  }

  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runNotificationScan();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[notifications] cron scan error:', err);
    return NextResponse.json(
      { ok: false, reason: 'internal_error' },
      { status: 500 },
    );
  }
}
