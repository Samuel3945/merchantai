import { Buffer } from 'node:buffer';
import { and, asc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import { salePaymentsSchema, salesSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOTES_NAME_RE = /(?:Cliente|Nombre):\s*([^|]+)/i;
const NOTES_PHONE_RE = /Tel:\s*([^|]+)/i;

type FiadoRisk = 'high' | 'mid' | 'low';

type FiadoSale = {
  id: string;
  total: number;
  paid: number;
  pending: number;
  createdAt: string;
  daysOld: number;
};

type FiadoClient = {
  clientKey: string;
  name: string;
  phone: string;
  totalOwed: number;
  oldestDays: number;
  risk: FiadoRisk;
  sales: FiadoSale[];
};

function parseClient(notes: string | null): { name: string; phone: string } {
  if (!notes) {
    return { name: '', phone: '' };
  }
  return {
    name: notes.match(NOTES_NAME_RE)?.[1]?.trim() ?? '',
    phone: notes.match(NOTES_PHONE_RE)?.[1]?.trim() ?? '',
  };
}

function encodeClientKey(name: string, phone: string): string {
  return Buffer.from(`${name}||${phone}`, 'utf8').toString('base64url');
}

function riskFor(days: number): FiadoRisk {
  if (days >= 7) {
    return 'high';
  }
  if (days >= 3) {
    return 'mid';
  }
  return 'low';
}

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  const fiadoCondition = or(
    ilike(salesSchema.paymentType, '%fiado%'),
    exists(
      db
        .select({ one: sql`1` })
        .from(salePaymentsSchema)
        .where(
          and(
            eq(salePaymentsSchema.saleId, salesSchema.id),
            ilike(salePaymentsSchema.method, '%fiado%'),
          ),
        ),
    ),
  );

  const sales = await db
    .selectDistinct({
      id: salesSchema.id,
      total: salesSchema.total,
      notes: salesSchema.notes,
      paymentType: salesSchema.paymentType,
      createdAt: salesSchema.createdAt,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.organizationId, ctx.organizationId),
        eq(salesSchema.status, 'completed'),
        fiadoCondition,
      ),
    )
    .orderBy(asc(salesSchema.createdAt));

  if (sales.length === 0) {
    return NextResponse.json({
      stats: { total_owed: 0, urgent: 0, remind: 0, ok: 0, total_clients: 0 },
      clients: [],
    });
  }

  const saleIds = sales.map(s => s.id);
  const paidRows = await db
    .select({
      saleId: salePaymentsSchema.saleId,
      sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
    })
    .from(salePaymentsSchema)
    .where(
      and(
        inArray(salePaymentsSchema.saleId, saleIds),
        sql`${salePaymentsSchema.method} NOT ILIKE '%fiado%'`,
      ),
    )
    .groupBy(salePaymentsSchema.saleId);

  const paidBySale = new Map<string, number>();
  for (const row of paidRows) {
    paidBySale.set(row.saleId, Number.parseFloat(row.sum) || 0);
  }

  const now = Date.now();
  const groups = new Map<string, FiadoClient>();

  for (const s of sales) {
    const { name, phone } = parseClient(s.notes);
    const key = encodeClientKey(name, phone);
    const total = Number.parseFloat(s.total) || 0;
    const paid = paidBySale.get(s.id) ?? 0;
    const pending = Math.max(0, Number.parseFloat((total - paid).toFixed(2)));
    const createdAtMs = new Date(s.createdAt).getTime();
    const daysOld = Math.max(
      0,
      Math.floor((now - createdAtMs) / (1000 * 60 * 60 * 24)),
    );

    let group = groups.get(key);
    if (!group) {
      group = {
        clientKey: key,
        name: name || 'Sin nombre',
        phone,
        totalOwed: 0,
        oldestDays: 0,
        risk: 'low',
        sales: [],
      };
      groups.set(key, group);
    }

    group.totalOwed = Number.parseFloat((group.totalOwed + total).toFixed(2));
    if (daysOld > group.oldestDays) {
      group.oldestDays = daysOld;
    }
    group.sales.push({
      id: s.id,
      total,
      paid,
      pending,
      createdAt: s.createdAt.toISOString(),
      daysOld,
    });
  }

  const clients = Array.from(groups.values())
    .map((g) => {
      g.risk = riskFor(g.oldestDays);
      return g;
    })
    .sort((a, b) => b.oldestDays - a.oldestDays);

  const stats = {
    total_owed: Number.parseFloat(
      clients.reduce((acc, c) => acc + c.totalOwed, 0).toFixed(2),
    ),
    urgent: clients.filter(c => c.risk === 'high').length,
    remind: clients.filter(c => c.risk === 'mid').length,
    ok: clients.filter(c => c.risk === 'low').length,
    total_clients: clients.length,
  };

  return NextResponse.json({ stats, clients });
}
