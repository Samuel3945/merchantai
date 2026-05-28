import { NextResponse } from 'next/server';
import { recomputeAll } from '@/libs/expiration-engine';

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
    const result = await recomputeAll();
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    console.error('[expiration] cron recompute error:', err);
    return NextResponse.json(
      { ok: false, reason: 'internal_error' },
      { status: 500 },
    );
  }
}
