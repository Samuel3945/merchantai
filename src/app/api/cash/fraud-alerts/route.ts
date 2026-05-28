import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getFraudAlerts } from '@/actions/cash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const { userId, orgId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!orgId) {
    return NextResponse.json({ error: 'no_active_org' }, { status: 400 });
  }

  const url = new URL(req.url);
  const daysParam = url.searchParams.get('days');
  const parsed = daysParam ? Number.parseInt(daysParam, 10) : 14;
  const days = Number.isFinite(parsed) ? parsed : 14;

  try {
    const alerts = await getFraudAlerts(days);
    const severity = alerts.some(a => a.severity === 'high')
      ? 'high'
      : alerts.some(a => a.severity === 'mid')
        ? 'mid'
        : alerts.some(a => a.severity === 'low')
          ? 'low'
          : null;
    return NextResponse.json({ ok: true, days, severity, alerts });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Error al calcular fraud alerts',
      },
      { status: 400 },
    );
  }
}
