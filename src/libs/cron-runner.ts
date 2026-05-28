// Shared runner for Vercel Cron endpoints.
//
// Vercel injects `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs). This
// helper centralizes that check plus a structured log line {cron, ranAt,
// processed, errors, durationMs} so every job is auditable in Vercel logs.

import { NextResponse } from 'next/server';
import { logger } from '@/libs/Logger';

export type CronResultBase = {
  processed: number;
  [extra: string]: unknown;
};

export async function runCron<T extends CronResultBase>(
  cron: string,
  req: Request,
  handler: () => Promise<T>,
): Promise<NextResponse> {
  const ranAt = new Date().toISOString();
  const startedAt = Date.now();

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error('cron misconfigured', {
      cron,
      ranAt,
      processed: 0,
      errors: ['cron_secret_not_configured'],
    });
    return NextResponse.json(
      { ok: false, reason: 'cron_secret_not_configured' },
      { status: 500 },
    );
  }

  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    logger.warn('cron unauthorized', {
      cron,
      ranAt,
      processed: 0,
      errors: ['unauthorized'],
    });
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await handler();
    const durationMs = Date.now() - startedAt;
    logger.info('cron completed', {
      cron,
      ranAt,
      errors: [],
      durationMs,
      ...result,
    });
    return NextResponse.json({ ok: true, cron, ranAt, durationMs, ...result });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.error('cron failed', {
      cron,
      ranAt,
      processed: 0,
      errors: [message],
      durationMs,
    });
    return NextResponse.json(
      { ok: false, cron, ranAt, durationMs, reason: 'internal_error' },
      { status: 500 },
    );
  }
}
