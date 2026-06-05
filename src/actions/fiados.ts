'use server';

import { Buffer } from 'node:buffer';
import { auth } from '@clerk/nextjs/server';
import { and, asc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/DB';
import { salePaymentsSchema, salesSchema } from '@/models/Schema';

const NOTES_NAME_RE = /(?:Cliente|Nombre):\s*([^|]+)/i;
const NOTES_PHONE_RE = /Tel:\s*([^|]+)/i;

export type FiadoRisk = 'high' | 'mid' | 'low';

export type FiadoSale = {
  id: string;
  saleNumber: number | null;
  total: number;
  paid: number;
  pending: number;
  createdAt: string;
  daysOld: number;
};

export type FiadoClient = {
  clientKey: string;
  name: string;
  phone: string;
  totalOwed: number;
  oldestDays: number;
  risk: FiadoRisk;
  sales: FiadoSale[];
};

export type FiadoStats = {
  total_owed: number;
  urgent: number;
  remind: number;
  ok: number;
  total_clients: number;
};

export type GetPendingFiadosResult = {
  stats: FiadoStats;
  clients: FiadoClient[];
};

function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

function parseClient(notes: string | null): { name: string; phone: string } {
  if (!notes) {
    return { name: '', phone: '' };
  }
  const name = notes.match(NOTES_NAME_RE)?.[1]?.trim() ?? '';
  const phone = notes.match(NOTES_PHONE_RE)?.[1]?.trim() ?? '';
  return { name, phone };
}

function encodeClientKey(name: string, phone: string): string {
  return Buffer.from(`${name}||${phone}`, 'utf8').toString('base64url');
}

function decodeClientKey(key: string): { name: string; phone: string } {
  const raw = Buffer.from(key, 'base64url').toString('utf8');
  const idx = raw.indexOf('||');
  if (idx === -1) {
    return { name: raw, phone: '' };
  }
  return { name: raw.slice(0, idx), phone: raw.slice(idx + 2) };
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

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

export async function getPendingFiados(): Promise<GetPendingFiadosResult> {
  const { orgId } = await requireOrg();

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
      saleNumber: salesSchema.saleNumber,
      total: salesSchema.total,
      notes: salesSchema.notes,
      paymentType: salesSchema.paymentType,
      createdAt: salesSchema.createdAt,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.organizationId, orgId),
        eq(salesSchema.status, 'completed'),
        fiadoCondition,
      ),
    )
    .orderBy(asc(salesSchema.createdAt));

  if (sales.length === 0) {
    return {
      stats: { total_owed: 0, urgent: 0, remind: 0, ok: 0, total_clients: 0 },
      clients: [],
    };
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
      saleNumber: s.saleNumber,
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

  const stats: FiadoStats = {
    total_owed: Number.parseFloat(
      clients.reduce((acc, c) => acc + c.totalOwed, 0).toFixed(2),
    ),
    urgent: clients.filter(c => c.risk === 'high').length,
    remind: clients.filter(c => c.risk === 'mid').length,
    ok: clients.filter(c => c.risk === 'low').length,
    total_clients: clients.length,
  };

  return { stats, clients };
}

export async function settleFiados(saleIds: string[]): Promise<{ updated: number }> {
  const { orgId } = await requireOrg();

  const ids = (saleIds ?? []).filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) {
    return { updated: 0 };
  }

  const updated = await db
    .update(salesSchema)
    .set({ status: 'settled' })
    .where(
      and(
        eq(salesSchema.organizationId, orgId),
        eq(salesSchema.status, 'completed'),
        inArray(salesSchema.id, ids),
      ),
    )
    .returning({ id: salesSchema.id });

  revalidatePath('/dashboard/fiados');
  revalidatePath('/dashboard/sales');
  return { updated: updated.length };
}

export type AbonarFiadoResult = {
  applied: number;
  remaining: number;
  settledSaleIds: string[];
};

export async function abonarFiado(
  clientKey: string,
  amount: number | string,
  method: string,
): Promise<AbonarFiadoResult> {
  const { orgId } = await requireOrg();

  const amt = Number.parseFloat(toMoney(amount));
  if (amt <= 0) {
    throw new Error('El abono debe ser mayor a 0');
  }
  const methodTrimmed = method?.trim();
  if (!methodTrimmed) {
    throw new Error('Método de pago requerido');
  }
  if (/fiado/i.test(methodTrimmed)) {
    throw new Error('El abono no puede ser de tipo fiado');
  }

  const { name, phone } = decodeClientKey(clientKey);

  const result = await db.transaction(async (tx) => {
    const fiadoCondition = or(
      ilike(salesSchema.paymentType, '%fiado%'),
      exists(
        tx
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

    const candidateSales = await tx
      .select({
        id: salesSchema.id,
        total: salesSchema.total,
        notes: salesSchema.notes,
        paymentType: salesSchema.paymentType,
        createdAt: salesSchema.createdAt,
      })
      .from(salesSchema)
      .where(
        and(
          eq(salesSchema.organizationId, orgId),
          eq(salesSchema.status, 'completed'),
          fiadoCondition,
        ),
      )
      .orderBy(asc(salesSchema.createdAt))
      .for('update');

    const matching = candidateSales.filter((s) => {
      const parsed = parseClient(s.notes);
      return parsed.name === name && parsed.phone === phone;
    });

    if (matching.length === 0) {
      throw new Error('No se encontraron fiados pendientes para este cliente');
    }

    let remaining = amt;
    const settledSaleIds: string[] = [];

    for (const sale of matching) {
      if (remaining <= 0) {
        break;
      }

      const [paidRow] = await tx
        .select({
          sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
        })
        .from(salePaymentsSchema)
        .where(
          and(
            eq(salePaymentsSchema.saleId, sale.id),
            sql`${salePaymentsSchema.method} NOT ILIKE '%fiado%'`,
          ),
        );

      const total = Number.parseFloat(sale.total) || 0;
      const paid = Number.parseFloat(paidRow?.sum ?? '0') || 0;
      const pending = Number.parseFloat((total - paid).toFixed(2));
      if (pending <= 0) {
        await tx
          .update(salesSchema)
          .set({ status: 'settled' })
          .where(eq(salesSchema.id, sale.id));
        settledSaleIds.push(sale.id);
        continue;
      }

      const toApply = Math.min(remaining, pending);
      const applied = Number.parseFloat(toApply.toFixed(2));

      await tx.insert(salePaymentsSchema).values({
        saleId: sale.id,
        method: methodTrimmed,
        amount: toMoney(applied),
        reference: `Abono fiado ${name || 'cliente'}`.trim(),
        billsPaid: null,
        changeGiven: '0',
      });

      remaining = Number.parseFloat((remaining - applied).toFixed(2));

      if (applied >= pending) {
        await tx
          .update(salesSchema)
          .set({ status: 'settled' })
          .where(eq(salesSchema.id, sale.id));
        settledSaleIds.push(sale.id);
      }
    }

    return {
      applied: Number.parseFloat((amt - remaining).toFixed(2)),
      remaining: Number.parseFloat(remaining.toFixed(2)),
      settledSaleIds,
    };
  });

  revalidatePath('/dashboard/fiados');
  revalidatePath('/dashboard/sales');
  return result;
}
