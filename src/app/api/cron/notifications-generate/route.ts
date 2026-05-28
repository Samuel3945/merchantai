import type { NextResponse } from 'next/server';
import { runNotificationScan } from '@/actions/notifications';
import { runCron } from '@/libs/cron-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<NextResponse> {
  return runCron('notifications-generate', req, async () => {
    const result = await runNotificationScan();
    return {
      processed: result.created,
      orgs: result.orgs,
      created: result.created,
    };
  });
}
