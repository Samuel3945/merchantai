import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { getCustomerCreditSummary } from '@/libs/creditos';
import { db } from '@/libs/DB';
import {
  customersSchema,
  deliveryOrdersSchema,
  salesSchema,
} from '@/models/Schema';

// Single-customer profile core (no auth): identity, headline KPIs, and a
// per-source history (linked sales, credit abonos, deliveries). ONE org-scoped
// shape so the dashboard profile page (Clerk auth) and the POS side panel
// (cashier auth) read exactly the same contract. Sales are linked via
// sales.customer_id (stamped at the sale paths + backfilled); credit balance and
// abonos are resolved by IDENTITY via getCustomerCreditSummary — NOT by the
// customer FK alone, because most POS creditos have customer_id = NULL and group
// under `n:<name||phone>`, so an FK-only lookup would show 0 while the créditos
// wall shows the debt.

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CustomerDetailProfile = {
  id: string;
  name: string;
  documentId: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  totalSpent: string;
  lastPurchaseAt: Date | null;
  createdAt: Date;
};

export type CustomerDetailKpis = {
  /** Lifetime accumulator (invoice-tagged bumps). */
  totalSpent: string;
  /** Count of sales linked to this customer. */
  purchaseCount: number;
  /** Average total over the linked sales (0 when none). */
  avgTicket: number;
  lastPurchaseAt: Date | null;
  /** Outstanding fiado balance (pending creditos linked to this customer). */
  creditBalance: number;
};

export type CustomerDetailSaleItem = {
  productName: string;
  qty: number;
  unitType: string;
};

export type CustomerDetailSale = {
  id: string;
  saleNumber: number | null;
  date: Date;
  total: string;
  paymentType: string;
  status: string;
  /** Every sold unit returned (by quantity), same rule as the sales listing. */
  fullyReturned: boolean;
  /** Qué pidió el cliente en esta venta (para la ficha). */
  items: CustomerDetailSaleItem[];
};

export type CustomerDetailAbono = {
  id: string;
  date: Date;
  amount: number;
  method: string | null;
};

export type CustomerDetailDelivery = {
  id: string;
  date: Date;
  total: string;
  status: string;
};

export type CustomerDetail = {
  profile: CustomerDetailProfile;
  kpis: CustomerDetailKpis;
  recentSales: CustomerDetailSale[];
  credito: { balance: number; recentAbonos: CustomerDetailAbono[] };
  deliveries: CustomerDetailDelivery[];
};

const RECENT_SALES_LIMIT = 25;
const RECENT_ABONOS_LIMIT = 25;
const RECENT_DELIVERIES_LIMIT = 25;

export async function loadCustomerDetail(
  organizationId: string,
  customerId: string,
): Promise<CustomerDetail | null> {
  if (!UUID_RE.test(customerId)) {
    return null;
  }

  const [profile] = await db
    .select({
      id: customersSchema.id,
      name: customersSchema.name,
      documentId: customersSchema.documentId,
      whatsapp: customersSchema.whatsapp,
      email: customersSchema.email,
      address: customersSchema.address,
      notes: customersSchema.notes,
      totalSpent: customersSchema.totalSpent,
      lastPurchaseAt: customersSchema.lastPurchaseAt,
      createdAt: customersSchema.createdAt,
    })
    .from(customersSchema)
    .where(
      and(
        eq(customersSchema.id, customerId),
        eq(customersSchema.organizationId, organizationId),
        eq(customersSchema.deleted, false),
      ),
    )
    .limit(1);

  if (!profile) {
    return null;
  }

  // Créditos por IDENTIDAD (FK OR whatsapp OR name) primero: la mayoría de las
  // ventas fiadas del POS quedan con customer_id NULL y se ligan al cliente por
  // el crédito. Necesitamos sus saleIds para que las COMPRAS (no solo los abonos)
  // aparezcan en la ficha.
  const creditSummary = await getCustomerCreditSummary(organizationId, {
    id: profile.id,
    name: profile.name,
    whatsapp: profile.whatsapp,
  });

  // Sales linked to this customer: por FK directo O por identidad (vía crédito).
  // Same status scope as the sales listing so the KPIs and the rows agree.
  // fullyReturned uses literal table refs — see the note in actions/sales.ts on
  // why drizzle column interpolation misfires here.
  const linkedStatuses = ['completed', 'settled', 'returned'] as const;
  const saleWhere = and(
    eq(salesSchema.organizationId, organizationId),
    inArray(salesSchema.status, linkedStatuses),
    creditSummary.saleIds.length > 0
      ? or(
          eq(salesSchema.customerId, customerId),
          inArray(salesSchema.id, creditSummary.saleIds),
        )
      : eq(salesSchema.customerId, customerId),
  );

  const [agg, recentSales, deliveries] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        sum: sql<number>`COALESCE(SUM(${salesSchema.total}), 0)::float8`,
      })
      .from(salesSchema)
      .where(saleWhere),
    db
      .select({
        id: salesSchema.id,
        saleNumber: salesSchema.saleNumber,
        date: salesSchema.createdAt,
        total: salesSchema.total,
        paymentType: salesSchema.paymentType,
        status: salesSchema.status,
        fullyReturned: sql<boolean>`(
          EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)
          AND COALESCE((
            SELECT SUM(pri.qty)
            FROM pos_return_items pri
            JOIN sale_items si ON si.id = pri.sale_item_id
            WHERE si.sale_id = sales.id
          ), 0) >= COALESCE((
            SELECT SUM(si2.qty) FROM sale_items si2 WHERE si2.sale_id = sales.id
          ), 0)
        )`,
        // Qué pidió: productos de la venta (nombre + cantidad) para la ficha.
        items: sql<CustomerDetailSaleItem[]>`COALESCE((
          SELECT json_agg(json_build_object(
            'productName', si.product_name,
            'qty', si.qty,
            'unitType', COALESCE(si.unit_type, 'unit')
          ) ORDER BY si.id)
          FROM sale_items si WHERE si.sale_id = sales.id
        ), '[]'::json)`,
      })
      .from(salesSchema)
      .where(saleWhere)
      .orderBy(desc(salesSchema.createdAt))
      .limit(RECENT_SALES_LIMIT),
    db
      .select({
        id: deliveryOrdersSchema.id,
        date: deliveryOrdersSchema.createdAt,
        total: deliveryOrdersSchema.total,
        status: deliveryOrdersSchema.status,
      })
      .from(deliveryOrdersSchema)
      .where(
        and(
          eq(deliveryOrdersSchema.organizationId, organizationId),
          eq(deliveryOrdersSchema.customerId, customerId),
        ),
      )
      .orderBy(desc(deliveryOrdersSchema.createdAt))
      .limit(RECENT_DELIVERIES_LIMIT),
  ]);

  const purchaseCount = agg[0]?.count ?? 0;
  const salesSum = agg[0]?.sum ?? 0;
  const creditBalance = creditSummary.balance;
  const recentAbonos: CustomerDetailAbono[] = creditSummary.abonos
    .slice(0, RECENT_ABONOS_LIMIT)
    .map(a => ({
      id: a.id,
      date: new Date(a.createdAt),
      amount: a.amount,
      method: a.method,
    }));

  return {
    profile,
    kpis: {
      totalSpent: profile.totalSpent,
      purchaseCount,
      avgTicket: purchaseCount > 0 ? salesSum / purchaseCount : 0,
      lastPurchaseAt: profile.lastPurchaseAt,
      creditBalance,
    },
    recentSales,
    credito: { balance: creditBalance, recentAbonos },
    deliveries,
  };
}
