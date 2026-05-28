'use server';

import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/DB';
import {
  expirationSuggestionsSchema,
  notificationsSchema,
  productsSchema,
  salePaymentsSchema,
  salesSchema,
} from '@/models/Schema';

export type Notification = typeof notificationsSchema.$inferSelect;

export type NotificationKind
  = | 'cash_difference'
    | 'low_stock'
    | 'expiring_soon'
    | 'fiado_overdue'
    | 'sale_alert';

export type NotificationSeverity = 'low' | 'mid' | 'high';

async function requireOrgId() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return orgId;
}

export type CreateNotificationInput = {
  organizationId: string;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
};

// Internal helper used by generators and other actions. Skips Clerk auth so
// it can be invoked from cron jobs and transactional side-effects.
export async function createNotification(
  input: CreateNotificationInput,
): Promise<Notification> {
  const [row] = await db
    .insert(notificationsSchema)
    .values({
      organizationId: input.organizationId,
      kind: input.kind,
      severity: input.severity ?? 'mid',
      title: input.title,
      message: input.message,
      payload: input.payload ?? {},
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create notification');
  }
  return row;
}

export type ListNotificationsParams = {
  unreadOnly?: boolean;
  limit?: number;
};

export async function listNotifications(
  params?: ListNotificationsParams,
): Promise<Notification[]> {
  const orgId = await requireOrgId();
  const limit = Math.min(Math.max(params?.limit ?? 20, 1), 100);

  const filters = [eq(notificationsSchema.organizationId, orgId)];
  if (params?.unreadOnly) {
    filters.push(eq(notificationsSchema.read, false));
  }

  return db
    .select()
    .from(notificationsSchema)
    .where(and(...filters))
    .orderBy(desc(notificationsSchema.createdAt))
    .limit(limit);
}

export async function getUnreadCount(): Promise<number> {
  const orgId = await requireOrgId();
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(notificationsSchema)
    .where(
      and(
        eq(notificationsSchema.organizationId, orgId),
        eq(notificationsSchema.read, false),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function markAsRead(id: string): Promise<{ id: string }> {
  const orgId = await requireOrgId();
  const [row] = await db
    .update(notificationsSchema)
    .set({ read: true })
    .where(
      and(
        eq(notificationsSchema.id, id),
        eq(notificationsSchema.organizationId, orgId),
      ),
    )
    .returning({ id: notificationsSchema.id });
  if (!row) {
    throw new Error('Notification not found');
  }
  revalidatePath('/dashboard');
  return { id: row.id };
}

export async function markAllAsRead(): Promise<{ updated: number }> {
  const orgId = await requireOrgId();
  const rows = await db
    .update(notificationsSchema)
    .set({ read: true })
    .where(
      and(
        eq(notificationsSchema.organizationId, orgId),
        eq(notificationsSchema.read, false),
      ),
    )
    .returning({ id: notificationsSchema.id });
  revalidatePath('/dashboard');
  return { updated: rows.length };
}

// ─── Automatic generators ──────────────────────────────────────────────────
// Each generator is idempotent: it dedupes against the most recent unread
// notification of the same kind+target so the bell isn't spammed every minute.

const CASH_DIFFERENCE_THRESHOLD = 10_000;
const FIADO_OVERDUE_DAYS = 7;
const DEDUP_WINDOW_HOURS = 24;

async function existsRecentUnread(
  organizationId: string,
  kind: NotificationKind,
  targetKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationsSchema.id })
    .from(notificationsSchema)
    .where(
      and(
        eq(notificationsSchema.organizationId, organizationId),
        eq(notificationsSchema.kind, kind),
        eq(notificationsSchema.read, false),
        sql`${notificationsSchema.payload}->>'targetKey' = ${targetKey}`,
        gte(
          notificationsSchema.createdAt,
          sql`now() - (${DEDUP_WINDOW_HOURS}::text || ' hours')::interval`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function notifyCashDifference(input: {
  organizationId: string;
  sessionId: string;
  difference: number;
}): Promise<Notification | null> {
  const absDiff = Math.abs(input.difference);
  if (absDiff <= CASH_DIFFERENCE_THRESHOLD) {
    return null;
  }
  const sign = input.difference < 0 ? 'faltante' : 'sobrante';
  return createNotification({
    organizationId: input.organizationId,
    kind: 'cash_difference',
    severity: 'high',
    title: 'Diferencia importante al cerrar caja',
    message: `Cierre con ${sign} de $${absDiff.toLocaleString('es-CO')}. Revisa los movimientos.`,
    payload: {
      targetKey: `cash:${input.sessionId}`,
      sessionId: input.sessionId,
      difference: input.difference,
    },
  });
}

export async function generateLowStockNotifications(
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({
      id: productsSchema.id,
      name: productsSchema.name,
      stock: productsSchema.stock,
      minStock: productsSchema.minStock,
    })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.organizationId, organizationId),
        eq(productsSchema.deleted, false),
        sql`${productsSchema.minStock} > 0`,
        lte(productsSchema.stock, productsSchema.minStock),
      ),
    );

  let created = 0;
  for (const row of rows) {
    const targetKey = `product:${row.id}`;
    if (await existsRecentUnread(organizationId, 'low_stock', targetKey)) {
      continue;
    }
    const severity: NotificationSeverity
      = row.stock <= 0 ? 'high' : 'mid';
    await createNotification({
      organizationId,
      kind: 'low_stock',
      severity,
      title: row.stock <= 0 ? 'Producto sin stock' : 'Stock bajo',
      message: `${row.name}: quedan ${row.stock} unidades (mínimo ${row.minStock}).`,
      payload: {
        targetKey,
        productId: row.id,
        productName: row.name,
        stock: row.stock,
        minStock: row.minStock,
      },
    });
    created++;
  }
  return created;
}

export async function generateExpiringSoonNotifications(
  organizationId: string,
): Promise<number> {
  // Hook into the existing expiration engine: any pending suggestion that just
  // escalated to 'urgente' or 'critico' becomes a bell entry.
  const rows = await db
    .select({
      id: expirationSuggestionsSchema.id,
      productId: expirationSuggestionsSchema.productId,
      tier: expirationSuggestionsSchema.tier,
      suggestedPct: expirationSuggestionsSchema.suggestedPct,
      reasoning: expirationSuggestionsSchema.reasoning,
    })
    .from(expirationSuggestionsSchema)
    .where(
      and(
        eq(expirationSuggestionsSchema.organizationId, organizationId),
        eq(expirationSuggestionsSchema.status, 'pending'),
        ne(expirationSuggestionsSchema.tier, 'atencion'),
      ),
    );

  let created = 0;
  for (const row of rows) {
    const targetKey = `suggestion:${row.id}`;
    if (await existsRecentUnread(organizationId, 'expiring_soon', targetKey)) {
      continue;
    }
    const [product] = await db
      .select({ name: productsSchema.name })
      .from(productsSchema)
      .where(eq(productsSchema.id, row.productId))
      .limit(1);
    const severity: NotificationSeverity
      = row.tier === 'critico' ? 'high' : 'mid';
    await createNotification({
      organizationId,
      kind: 'expiring_soon',
      severity,
      title: row.tier === 'critico' ? 'Lote por vencer (crítico)' : 'Lote por vencer',
      message: `${product?.name ?? 'Producto'}: descuento sugerido ${Number(row.suggestedPct).toFixed(0)}%. ${row.reasoning}`,
      payload: {
        targetKey,
        suggestionId: row.id,
        productId: row.productId,
        tier: row.tier,
      },
    });
    created++;
  }
  return created;
}

export async function generateFiadoOverdueNotifications(
  organizationId: string,
): Promise<number> {
  // Fiado is stored as sales with payment_type='credit'. A "client" is
  // identified by the notes-encoded name|phone fields used by the fiados
  // feature. We aggregate per sale (clientKey not stable without joining
  // customers); the dedup window keeps duplicates out of the bell.
  const result = await db.execute<{
    sale_id: string;
    total: string;
    paid: string;
    created_at: Date;
    days_old: number;
    notes: string | null;
  }>(sql`
    SELECT
      s.id AS sale_id,
      s.total::text AS total,
      COALESCE(SUM(p.amount), 0)::text AS paid,
      s.created_at,
      EXTRACT(DAY FROM (now() - s.created_at))::int AS days_old,
      s.notes
    FROM ${salesSchema} s
    LEFT JOIN ${salePaymentsSchema} p ON p.sale_id = s.id AND p.method = 'credit'
    WHERE s.organization_id = ${organizationId}
      AND s.payment_type = 'credit'
      AND s.status = 'completed'
      AND s.created_at <= now() - (${FIADO_OVERDUE_DAYS}::text || ' days')::interval
    GROUP BY s.id
    HAVING s.total > COALESCE(SUM(p.amount), 0)
  `);

  let created = 0;
  for (const row of result.rows as Array<{
    sale_id: string;
    total: string;
    paid: string;
    days_old: number;
    notes: string | null;
  }>) {
    const targetKey = `sale:${row.sale_id}`;
    if (await existsRecentUnread(organizationId, 'fiado_overdue', targetKey)) {
      continue;
    }
    const pending = Number(row.total) - Number(row.paid);
    const nameMatch = row.notes?.match(/(?:Cliente|Nombre):\s*([^|]+)/i);
    const client = nameMatch?.[1]?.trim() || 'Cliente';
    await createNotification({
      organizationId,
      kind: 'fiado_overdue',
      severity: row.days_old >= 14 ? 'high' : 'mid',
      title: 'Fiado vencido',
      message: `${client} lleva ${row.days_old} días sin pagar $${pending.toLocaleString('es-CO')}.`,
      payload: {
        targetKey,
        saleId: row.sale_id,
        pending,
        daysOld: row.days_old,
      },
    });
    created++;
  }
  return created;
}

// Scans every org with recent activity. Called from the cron endpoint.
export async function runNotificationScan(): Promise<{
  orgs: number;
  created: number;
}> {
  const orgRows = await db
    .selectDistinct({ organizationId: productsSchema.organizationId })
    .from(productsSchema)
    .where(eq(productsSchema.deleted, false));

  let total = 0;
  for (const { organizationId } of orgRows) {
    total += await generateLowStockNotifications(organizationId);
    total += await generateExpiringSoonNotifications(organizationId);
    total += await generateFiadoOverdueNotifications(organizationId);
  }
  return { orgs: orgRows.length, created: total };
}
