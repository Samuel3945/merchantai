import type { NextResponse } from 'next/server';
import { runBilling } from '@/actions/billing-runner';
import { runCron } from '@/libs/cron-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<NextResponse> {
  return runCron('wompi-billing', req, async () => {
    const result = await runBilling(100);
    return { ...result };
  });
}
