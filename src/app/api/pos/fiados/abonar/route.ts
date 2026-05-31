import { Buffer } from 'node:buffer';
import { and, asc, eq, exists, ilike, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import { salePaymentsSchema, salesSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AbonarBody = {
  clientKey?: string;
  amount?: number | string;
  method?: string;
  notes?: string | null;
};

const NOTES_NAME_RE = /(?:Cliente|Nombre):\s*([^|]+)/i;
const NOTES_PHONE_RE = /Tel:\s*([^|]+)/i;

function parseClient(notes: string | null): { name: string; phone: string } {
  if (!notes) {
    return { name: '', phone: '' };
  }
  return {
    name: notes.match(NOTES_NAME_RE)?.[1]?.trim() ?? '',
    phone: notes.match(NOTES_PHONE_RE)?.[1]?.trim() ?? '',
  };
}

function decodeClientKey(key: string): { name: string; phone: string } {
  const raw = Buffer.from(key, 'base64url').toString('utf8');
  const idx = raw.indexOf('||');
  if (idx === -1) {
    return { name: raw, phone: '' };
  }
  return { name: raw.slice(0, idx), phone: raw.slice(idx + 2) };
}

export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
  );
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  let body: AbonarBody;
  try {
    body = (await req.json()) as AbonarBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.clientKey) {
    return NextResponse.json(
      { error: 'clientKey es requerido' },
      { status: 400 },
    );
  }

  const amt = Number.parseFloat(toMoney(body.amount ?? 0));
  if (amt <= 0) {
    return NextResponse.json(
      { error: 'El abono debe ser mayor a 0' },
      { status: 400 },
    );
  }

  const method = body.method?.trim();
  if (!method) {
    return NextResponse.json(
      { error: 'method es requerido' },
      { status: 400 },
    );
  }
  if (/fiado/i.test(method)) {
    return NextResponse.json(
      { error: 'El abono no puede ser de tipo fiado' },
      { status: 400 },
    );
  }

  const { name, phone } = decodeClientKey(body.clientKey);

  try {
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
      const reference
        = (body.notes?.trim() || `Abono fiado ${name || 'cliente'}`).trim();

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
          method,
          amount: toMoney(applied),
          reference,
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

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Error al registrar abono',
      },
      { status: 400 },
    );
  }
}
