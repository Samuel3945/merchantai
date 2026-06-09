'use server';

import type { PlanName } from '@/libs/smart-stock';
import { auth } from '@clerk/nextjs/server';
import { eq, gte, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { currentPlan } from '@/actions/plans';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/db-context';
import {
  computeSmartStock,
  isProPlan,
  SMART_STOCK_SALES_WINDOW_DAYS,
  SMART_STOCK_SETTING_KEY,
} from '@/libs/smart-stock';
import {
  appSettingsSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
} from '@/models/Schema';

export type SmartStockSettings = {
  plan: PlanName;
  isPro: boolean;
  enabled: boolean;
};

// Inventory and the AI-agent view both read this. enabled is true only when the
// org is on a paid plan AND the flag is on — a downgrade silently reverts the
// minimum to manual without flipping any stored value.
export async function getSmartStockSettings(): Promise<SmartStockSettings> {
  const tdb = await db();
  const snapshot = await currentPlan();
  const plan = snapshot.subscription.plan as PlanName;
  const pro = isProPlan(plan);

  let flag = false;
  if (pro) {
    const [row] = await tdb
      .select({ value: appSettingsSchema.value })
      .from(appSettingsSchema)
      .where(eq(appSettingsSchema.key, SMART_STOCK_SETTING_KEY))
      .limit(1);
    flag = row?.value === 'true';
  }

  return { plan, isPro: pro, enabled: pro && flag };
}

// Toggle the model. Only org admins on a paid plan can turn it on. Turning it ON
// immediately recomputes every product's minimum from 30-day velocity so the
// table reflects the model right away.
export async function setSmartStockEnabled(
  enabled: boolean,
): Promise<SmartStockSettings> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Solo un administrador puede cambiar los Modelos Inteligentes');
  }

  const snapshot = await currentPlan();
  const plan = snapshot.subscription.plan as PlanName;
  if (enabled && !isProPlan(plan)) {
    throw new Error('Smart Stock requiere el plan Pro');
  }

  const tdb = await db();
  await tdb
    .insert(appSettingsSchema)
    .values({ key: SMART_STOCK_SETTING_KEY, value: enabled ? 'true' : 'false' })
    .onConflictDoUpdate({
      target: [appSettingsSchema.organizationId, appSettingsSchema.key],
      set: { value: enabled ? 'true' : 'false' },
    });

  if (enabled) {
    await recalcAllMinStock();
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'inventory.smart_stock.toggle',
    entityType: 'app_setting',
    entityId: SMART_STOCK_SETTING_KEY,
    after: { enabled },
  });

  revalidatePath('/dashboard/inventory');
  revalidatePath('/dashboard/ai-agent');

  return { plan, isPro: isProPlan(plan), enabled };
}

// Recompute products.minStock from each product's trailing-window sales using
// the shared deterministic heuristic. Runs on enable and can be called by a
// scheduled recompute later. NOT an LLM.
async function recalcAllMinStock(): Promise<void> {
  const tdb = await db();

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - SMART_STOCK_SALES_WINDOW_DAYS);

  const [products, velRows] = await Promise.all([
    tdb
      .select({ id: productsSchema.id })
      .from(productsSchema)
      .where(eq(productsSchema.deleted, false)),
    tdb
      .select({
        productId: saleItemsSchema.productId,
        totalQty: sql<string>`COALESCE(SUM(${saleItemsSchema.qty}), 0)`,
      })
      .from(salesSchema)
      .innerJoin(saleItemsSchema, eq(saleItemsSchema.saleId, salesSchema.id))
      .where(gte(salesSchema.createdAt, since))
      .groupBy(saleItemsSchema.productId),
  ]);

  const qtyByProduct = new Map<string, number>();
  for (const v of velRows) {
    qtyByProduct.set(v.productId, Number(v.totalQty));
  }

  for (const p of products) {
    const { suggestedMinStock, suggestedMaxStock } = computeSmartStock(
      qtyByProduct.get(p.id) ?? 0,
    );
    await tdb
      .update(productsSchema)
      .set({
        minStock: suggestedMinStock,
        stockMaxRecommended: suggestedMaxStock,
      })
      .where(eq(productsSchema.id, p.id));
  }
}
