import type { NextResponse } from 'next/server';
import { lt, sql } from 'drizzle-orm';
import { runCron } from '@/libs/cron-runner';
import { db } from '@/libs/DB';
import { posSessionsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<NextResponse> {
  return runCron('session-cleanup', req, async () => {
    const deleted = await db
      .delete(posSessionsSchema)
      .where(lt(posSessionsSchema.expiresAt, sql`now()`))
      .returning({ id: posSessionsSchema.id });

    return { processed: deleted.length, deleted: deleted.length };
  });
}
