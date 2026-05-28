import type { NextResponse } from 'next/server';
import { runCron } from '@/libs/cron-runner';
import { recomputeAll } from '@/libs/expiration-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<NextResponse> {
  return runCron('expiration-alerts', req, async () => {
    const result = await recomputeAll();
    return {
      processed: result.scannedBatches,
      scannedBatches: result.scannedBatches,
      cached: result.cached,
      suggestionsOpened: result.suggestionsOpened,
    };
  });
}
