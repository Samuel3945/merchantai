import { and, eq, ne } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { posUsersSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Device-scoped employee PIN hashes for OFFLINE PIN verification (REQ-09).
//
// Separated from GET /api/pos/sync on purpose: the bcrypt hashes (a) never
// co-travel with the bulk catalog payload, (b) ride a dedicated audited path,
// and (c) land straight into the device's hardware-backed secure store — NEVER
// into the main SQLite, where a 4-digit PIN's tiny keyspace would not survive a
// stolen DB file. Returns ONLY active employees of the device's org that have a
// PIN set; the hash rotates via the employee row's updatedAt on the next pull.
export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const rows = await db
    .select({ id: posUsersSchema.id, pinHash: posUsersSchema.pin })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, ctx.organizationId),
        eq(posUsersSchema.active, true),
        // Employees without a PIN cannot be verified offline — skip empty hashes.
        ne(posUsersSchema.pin, ''),
      ),
    );

  return NextResponse.json({
    secrets: rows.map(r => ({ id: r.id, pin_hash: r.pinHash })),
  });
}
