import type { NextResponse } from 'next/server';
import { lt, sql } from 'drizzle-orm';
import { runCron } from '@/libs/cron-runner';
import { db } from '@/libs/DB';
import { auditLogsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Retention: audit rows older than 365 days are purged daily. The product
// trail isn't a legal record; we keep a year so the dashboard can show
// recent history and trend filters without bloating the DB.
export async function GET(req: Request): Promise<NextResponse> {
  return runCron('audit-log-purge', req, async () => {
    const deleted = await db
      .delete(auditLogsSchema)
      .where(lt(auditLogsSchema.createdAt, sql`now() - interval '365 days'`))
      .returning({ id: auditLogsSchema.id });

    return { processed: deleted.length, deleted: deleted.length };
  });
}
