import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// This file defines the structure of your database tables using the Drizzle ORM.
//
// To modify the database schema:
// 1. Update this file with your desired changes.
// 2. Generate a new migration by running: `npm run db:generate`

export const todoSchema = pgTable('todo', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const productUnitTypeEnum = pgEnum('product_unit_type', ['unit', 'kg']);

export const productStatusEnum = pgEnum('product_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

// Warranty coverage a product ships with. Acts as a *default template* only:
// the binding warranty for a customer is snapshotted onto the sale line at sale
// time (see sale_items.warranty*), because validity depends on the sale date.
export const warrantyTypeEnum = pgEnum('warranty_type', [
  'none',
  'manufacturer',
  'store',
  'extended',
]);

export const productsSchema = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    barcode: text('barcode'),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    cost: numeric('cost', { precision: 10, scale: 2 })
      .default('0')
      .notNull(),
    stock: integer('stock').default(0).notNull(),
    minStock: integer('min_stock').default(0).notNull(),
    stockMaxRecommended: integer('stock_max_recommended'),
    category: text('category'),
    unitType: productUnitTypeEnum('unit_type').default('unit').notNull(),
    isPerishable: boolean('is_perishable').default(false).notNull(),
    isWholesale: boolean('is_wholesale').default(false).notNull(),
    wholesaleTiers: jsonb('wholesale_tiers'),
    attributes: jsonb('attributes').default({}).notNull(),
    // Warranty defaults (template). NULL warrantyType means "no warranty
    // configured"; durationDays is the coverage length copied onto the sale line.
    warrantyType: warrantyTypeEnum('warranty_type'),
    warrantyDurationDays: integer('warranty_duration_days'),
    status: productStatusEnum('status').default('published').notNull(),
    publishAt: timestamp('publish_at', { mode: 'date' }),
    deleted: boolean('deleted').default(false).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('products_org_barcode_unique_idx')
      .on(table.organizationId, table.barcode)
      .where(sql`${table.deleted} = false AND ${table.barcode} IS NOT NULL`),
    // The barcode unique index is partial, so the planner can't lean on it for
    // plain org listings/inventory. This covers product lists filtered by org.
    index('products_org_idx').on(table.organizationId, table.deleted),
  ],
);

export const saleStatusEnum = pgEnum('sale_status', [
  'completed',
  'settled',
  'cancelled',
  'returned',
]);

export const salesSchema = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Human-readable, per-organization sequential number (e.g. shown as "#1001").
    // The UUID stays the internal/backend identifier; this is the commercial one.
    // Allocated atomically via org_sale_counters — see libs/sale-number.ts.
    saleNumber: integer('sale_number'),
    total: numeric('total', { precision: 10, scale: 2 }).notNull(),
    paymentType: text('payment_type').default('cash').notNull(),
    status: saleStatusEnum('status').default('completed').notNull(),
    notes: text('notes'),
    cashierId: text('cashier_id'),
    posTokenId: uuid('pos_token_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Sales listings and date-range reports scan by org + time window.
    index('sales_org_created_idx').on(table.organizationId, table.createdAt),
    // Dashboard metrics filter org + status before the date range.
    index('sales_org_status_created_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    // One commercial number per organization; lets lookups by number be exact.
    uniqueIndex('sales_org_number_unique_idx').on(
      table.organizationId,
      table.saleNumber,
    ),
  ],
);

// Per-organization monotonic counter behind the human-readable sale number.
// A row is upserted-and-incremented inside the sale transaction so concurrent
// POS and dashboard sales can never be handed the same number.
export const orgSaleCountersSchema = pgTable('org_sale_counters', {
  organizationId: text('organization_id').primaryKey(),
  lastNumber: integer('last_number').default(0).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const saleItemsSchema = pgTable(
  'sale_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => salesSchema.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsSchema.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    qty: integer('qty').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull(),
    unitType: text('unit_type').default('unit').notNull(),
    // Warranty snapshot — frozen at sale time. The product only provides the
    // template; validity (warrantyEndsAt) is computed from the sale date so it
    // never shifts if the product's defaults change later. NULL = no warranty.
    warrantyType: warrantyTypeEnum('warranty_type'),
    warrantyDurationDays: integer('warranty_duration_days'),
    warrantyEndsAt: timestamp('warranty_ends_at', { mode: 'date' }),
  },
  table => [
    // Postgres does NOT auto-index FK columns. Metrics JOIN sale_items by
    // sale_id (WHERE sale_id IN ...) and aggregate by product_id.
    index('sale_items_sale_id_idx').on(table.saleId),
    index('sale_items_product_id_idx').on(table.productId),
  ],
);

export const salePaymentsSchema = pgTable('sale_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  saleId: uuid('sale_id')
    .notNull()
    .references(() => salesSchema.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  billsPaid: jsonb('bills_paid'),
  changeGiven: numeric('change_given', { precision: 10, scale: 2 })
    .default('0')
    .notNull(),
  reference: text('reference'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const salesRelations = relations(salesSchema, ({ many }) => ({
  items: many(saleItemsSchema),
  payments: many(salePaymentsSchema),
}));

export const saleItemsRelations = relations(saleItemsSchema, ({ one }) => ({
  sale: one(salesSchema, {
    fields: [saleItemsSchema.saleId],
    references: [salesSchema.id],
  }),
}));

export const salePaymentsRelations = relations(
  salePaymentsSchema,
  ({ one }) => ({
    sale: one(salesSchema, {
      fields: [salePaymentsSchema.saleId],
      references: [salesSchema.id],
    }),
  }),
);

export const cashSessionStatusEnum = pgEnum('cash_session_status', [
  'open',
  'closed',
]);

export const cashMovementTypeEnum = pgEnum('cash_movement_type', [
  'sale',
  'deposit',
  'expense',
  'salary',
  'inventory_purchase',
  'withdrawal',
  'adjustment',
  // Employee advance ("vale de empleado"): cash leaves the drawer but it is a
  // receivable against future salary, not a P&L expense. Behaves like withdrawal
  // for the cash math (a salida) and is excluded from operating expenses.
  'advance',
]);

export const cashSessionsSchema = pgTable(
  'cash_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    openedAt: timestamp('opened_at', { mode: 'date' }).defaultNow().notNull(),
    openedBy: text('opened_by').notNull(),
    openingAmount: numeric('opening_amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    closedAt: timestamp('closed_at', { mode: 'date' }),
    closedBy: text('closed_by'),
    expectedAmount: numeric('expected_amount', { precision: 12, scale: 2 }),
    countedAmount: numeric('counted_amount', { precision: 12, scale: 2 }),
    difference: numeric('difference', { precision: 12, scale: 2 }),
    status: cashSessionStatusEnum('status').default('open').notNull(),
    notes: text('notes'),
  },
  table => [
    uniqueIndex('cash_sessions_one_open_per_org_idx')
      .on(table.organizationId)
      .where(sql`${table.status} = 'open'`),
  ],
);

// ── Suppliers ────────────────────────────────────────────────────────────────
// Vendors the business buys goods/services from. Owned by Caja today (supplier
// payments) and intentionally generic so Compras, Inventario and Cuentas por
// Pagar can reuse it later. Archived (soft) instead of deleted, so a supplier
// with payment history can never be wiped and break the cash ledger.
export const supplierStatusEnum = pgEnum('supplier_status', [
  'active',
  'archived',
]);

export const suppliersSchema = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    company: text('company'),
    phone: text('phone'),
    email: text('email'),
    city: text('city'),
    address: text('address'),
    taxId: text('tax_id'),
    notes: text('notes'),
    status: supplierStatusEnum('status').default('active').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('suppliers_org_status_idx').on(table.organizationId, table.status),
    // NIT unique per org only when present — loading it stays optional.
    uniqueIndex('suppliers_org_tax_id_idx')
      .on(table.organizationId, table.taxId)
      .where(sql`${table.taxId} IS NOT NULL`),
  ],
);

export const cashMovementsSchema = pgTable(
  'cash_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => cashSessionsSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: cashMovementTypeEnum('type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    // Optional expense category for "pago de gasto" outflows (nomina, servicios,
    // arriendo, transporte, marketing, otros). Null for every other movement.
    category: text('category'),
    authorizedBy: text('authorized_by'),
    createdBy: text('created_by').notNull(),
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    // Set only for supplier payments. Soft-archive keeps the row; set null is the
    // safety net if a supplier is ever hard-deleted, so the movement survives.
    supplierId: uuid('supplier_id').references(() => suppliersSchema.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('cash_movements_org_supplier_idx')
      .on(table.organizationId, table.supplierId)
      .where(sql`${table.supplierId} IS NOT NULL`),
  ],
);

export const cashSessionsRelations = relations(
  cashSessionsSchema,
  ({ many }) => ({
    movements: many(cashMovementsSchema),
  }),
);

export const cashMovementsRelations = relations(
  cashMovementsSchema,
  ({ one }) => ({
    session: one(cashSessionsSchema, {
      fields: [cashMovementsSchema.sessionId],
      references: [cashSessionsSchema.id],
    }),
    sale: one(salesSchema, {
      fields: [cashMovementsSchema.saleId],
      references: [salesSchema.id],
    }),
    supplier: one(suppliersSchema, {
      fields: [cashMovementsSchema.supplierId],
      references: [suppliersSchema.id],
    }),
  }),
);

export const suppliersRelations = relations(suppliersSchema, ({ many }) => ({
  movements: many(cashMovementsSchema),
}));

// ── Cash security threshold cache ──────────────────────────────────────────
// One row per organization, UPSERTed by the daily cron (reuses the smart-stock
// recompute job). Lets Caja paint the risk level without recomputing the
// behavioural threshold on every page load. payload carries the explainable
// breakdown (signals + policy snapshot + reasoning).
export const cashSecurityThresholdCacheSchema = pgTable(
  'cash_security_threshold_cache',
  {
    organizationId: text('organization_id').primaryKey(),
    threshold: numeric('threshold', { precision: 14, scale: 2 }).notNull(),
    avgDailyInflow: numeric('avg_daily_inflow', {
      precision: 14,
      scale: 2,
    }).notNull(),
    accumulatedP85: numeric('accumulated_p85', {
      precision: 14,
      scale: 2,
    }).notNull(),
    daysOperated: integer('days_operated').notNull(),
    payload: jsonb('payload').notNull(),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
);

export const posUserRoleEnum = pgEnum('pos_user_role', [
  'admin',
  'cashier',
  'employee',
]);

// Cashier / employee accounts authenticated outside Clerk.
// Clerk handles org admins; this table holds the in-app POS users that log in
// with email + bcrypt password and consume short-lived session tokens.
export const posUsersSchema = pgTable(
  'pos_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    pin: text('pin').default('').notNull(),
    role: posUserRoleEnum('role').notNull(),
    active: boolean('active').default(true).notNull(),
    permissions: jsonb('permissions').default({}).notNull(),
    enabledModules: text('enabled_modules')
      .array()
      .default(sql`ARRAY['pos']::text[]`)
      .notNull(),
    canConfirmTransfers: boolean('can_confirm_transfers')
      .default(true)
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex('pos_users_email_unique_idx').on(table.email)],
);

export const posSessionsSchema = pgTable('pos_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => posUsersSchema.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const posUsersRelations = relations(posUsersSchema, ({ many }) => ({
  sessions: many(posSessionsSchema),
}));

export const posSessionsRelations = relations(posSessionsSchema, ({ one }) => ({
  user: one(posUsersSchema, {
    fields: [posSessionsSchema.userId],
    references: [posUsersSchema.id],
  }),
}));

// Device tokens used by POS terminals to authenticate sync requests.
// Each token is a UUID printed/generated as QR and bound to a device + optional cashier.
export const posTokensSchema = pgTable(
  'pos_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    token: uuid('token').notNull().defaultRandom(),
    storeId: text('store_id').default('main').notNull(),
    deviceName: text('device_name').notNull(),
    createdBy: text('created_by').notNull(),
    cashierId: uuid('cashier_id').references(() => posUsersSchema.id, {
      onDelete: 'set null',
    }),
    // active=false => caja bloqueada (no puede loguear ni sincronizar, pero la
    // fila persiste y libera cupo del plan). El borrado real elimina la fila.
    active: boolean('active').default(true).notNull(),
    // PIN de acceso de la caja (bcrypt). Se exige en /api/pos/login junto con el
    // token. '' => caja sin PIN (acceso directo con solo el token/QR).
    pin: text('pin').default('').notNull(),
    // Se incrementa cuando el admin "cierra la sesión" de la caja. El cajero
    // compara el epoch que conoce contra este; si difiere, bloquea al empleado
    // activo (vuelve al selector/PIN) sin perder el token de dispositivo.
    sessionEpoch: integer('session_epoch').default(0).notNull(),
    lastSyncAt: timestamp('last_sync_at', { mode: 'date' }),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [uniqueIndex('pos_tokens_token_unique_idx').on(table.token)],
);

export const posTokensRelations = relations(posTokensSchema, ({ one }) => ({
  cashier: one(posUsersSchema, {
    fields: [posTokensSchema.cashierId],
    references: [posUsersSchema.id],
  }),
}));

export const employeeInvitationStatusEnum = pgEnum(
  'employee_invitation_status',
  ['pending', 'accepted', 'revoked', 'expired'],
);

export const employeeInvitationsSchema = pgTable(
  'employee_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => posUsersSchema.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: posUserRoleEnum('role').notNull(),
    token: uuid('token').notNull().defaultRandom(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    status: employeeInvitationStatusEnum('status').default('pending').notNull(),
    permissions: jsonb('permissions').default({}).notNull(),
    enabledModules: text('enabled_modules')
      .array()
      .default(sql`ARRAY['pos']::text[]`)
      .notNull(),
    canConfirmTransfers: boolean('can_confirm_transfers')
      .default(true)
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('employee_invitations_token_unique_idx').on(table.token),
  ],
);

export const employeeInvitationsRelations = relations(
  employeeInvitationsSchema,
  ({ one }) => ({
    user: one(posUsersSchema, {
      fields: [employeeInvitationsSchema.userId],
      references: [posUsersSchema.id],
    }),
  }),
);

// Per-organization plan tier. Drives quota for cashiers, etc.
export const organizationPlanTierEnum = pgEnum('organization_plan_tier', [
  'free',
  'starter',
  'pro',
  'business',
]);

export const organizationPlansSchema = pgTable(
  'organization_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    plan: organizationPlanTierEnum('plan').default('free').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('organization_plans_org_unique_idx').on(table.organizationId),
  ],
);

// Per-organization paid add-ons. addon='pos_cashier' grants +1 cashier slot.
export const planAddonsSchema = pgTable('plan_addons', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  addon: text('addon').notNull(),
  qty: integer('qty').default(1).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Active and historical subscriptions. Only one row per org should have
// active=true at any time; upgradePlan() flips the prior row to false and
// inserts a new active one.
export const subscriptionsSchema = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    plan: text('plan').notNull(),
    active: boolean('active').default(true).notNull(),
    periodStart: timestamp('period_start', { mode: 'date' })
      .defaultNow()
      .notNull(),
    periodEnd: timestamp('period_end', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('subscriptions_one_active_per_org_idx')
      .on(table.organizationId)
      .where(sql`${table.active} = true`),
  ],
);

// One row per (org, agent_kind). monthly_limit comes from the plan;
// topped_up accumulates extra requests purchased; used is the consumption
// counter, reset on plan upgrade or billing-period rollover.
export const usageCountersSchema = pgTable(
  'usage_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    agentKind: text('agent_kind').notNull(),
    used: integer('used').default(0).notNull(),
    monthlyLimit: integer('monthly_limit').default(0).notNull(),
    toppedUp: integer('topped_up').default(0).notNull(),
    resetAt: timestamp('reset_at', { mode: 'date' }),
  },
  table => [
    uniqueIndex('usage_counters_org_agent_unique_idx').on(
      table.organizationId,
      table.agentKind,
    ),
  ],
);

// Append-only log of top-up purchases. The granted requests are also
// applied to usage_counters.topped_up at write time.
export const topUpsSchema = pgTable('top_ups', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  agentKind: text('agent_kind').notNull(),
  amountCop: numeric('amount_cop', { precision: 12, scale: 2 })
    .default('0')
    .notNull(),
  requestsAdded: integer('requests_added').default(0).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const customersSchema = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    documentId: text('document_id'),
    whatsapp: text('whatsapp'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    marketingOptIn: boolean('marketing_opt_in').default(true).notNull(),
    totalSpent: numeric('total_spent', { precision: 14, scale: 2 })
      .default('0')
      .notNull(),
    lastPurchaseAt: timestamp('last_purchase_at', { mode: 'date' }),
    createdBy: text('created_by'),
    deleted: boolean('deleted').default(false).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('customers_org_document_unique_idx')
      .on(table.organizationId, table.documentId)
      .where(
        sql`${table.documentId} IS NOT NULL AND ${table.deleted} = false`,
      ),
    uniqueIndex('customers_org_whatsapp_unique_idx')
      .on(table.organizationId, table.whatsapp)
      .where(
        sql`${table.whatsapp} IS NOT NULL AND ${table.deleted} = false`,
      ),
  ],
);

export const posReturnReasonEnum = pgEnum('pos_return_reason', [
  'wrong_product',
  'damaged',
  'customer_request',
  'price_error',
  'duplicate',
  'other',
  // Added with the reason-vs-destination split: why the customer returns.
  'business_error',
  'warranty',
]);

// Destination of returned goods — what physically happens to the merchandise,
// kept separate from the reason. Only 'restock' returns units to sellable stock.
export const posReturnDispositionEnum = pgEnum('pos_return_disposition', [
  'restock',
  'damaged',
  'warranty',
  'discard',
]);

export const posReturnsSchema = pgTable('pos_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  saleId: uuid('sale_id')
    .notNull()
    .references(() => salesSchema.id, { onDelete: 'restrict' }),
  reason: posReturnReasonEnum('reason').notNull(),
  notes: text('notes'),
  totalRefunded: numeric('total_refunded', { precision: 12, scale: 2 })
    .default('0')
    .notNull(),
  refundMethod: text('refund_method').notNull(),
  partial: boolean('partial').default(false).notNull(),
  cashierId: uuid('cashier_id').references(() => posUsersSchema.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const posReturnItemsSchema = pgTable('pos_return_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id')
    .notNull()
    .references(() => posReturnsSchema.id, { onDelete: 'cascade' }),
  saleItemId: uuid('sale_item_id')
    .notNull()
    .references(() => saleItemsSchema.id, { onDelete: 'restrict' }),
  productId: uuid('product_id').notNull(),
  productName: text('product_name').notNull(),
  qty: integer('qty').notNull(),
  refundAmount: numeric('refund_amount', { precision: 12, scale: 2 })
    .default('0')
    .notNull(),
  restock: boolean('restock').default(true).notNull(),
  // Where the returned goods went. Only 'restock' adds them back to sellable
  // stock; 'damaged' | 'warranty' | 'discard' are audit-only and never touch
  // inventory. `restock` stays in sync (true iff disposition === 'restock').
  disposition: posReturnDispositionEnum('disposition')
    .default('restock')
    .notNull(),
});

export const posReturnsRelations = relations(
  posReturnsSchema,
  ({ one, many }) => ({
    sale: one(salesSchema, {
      fields: [posReturnsSchema.saleId],
      references: [salesSchema.id],
    }),
    items: many(posReturnItemsSchema),
  }),
);

export const posReturnItemsRelations = relations(
  posReturnItemsSchema,
  ({ one }) => ({
    return: one(posReturnsSchema, {
      fields: [posReturnItemsSchema.returnId],
      references: [posReturnsSchema.id],
    }),
    saleItem: one(saleItemsSchema, {
      fields: [posReturnItemsSchema.saleItemId],
      references: [saleItemsSchema.id],
    }),
  }),
);

// ── Warranty claims ─────────────────────────────────────────────────────────
// First-class entity from day one even though v1 only *reads* warranty validity
// in the sale detail. Modelling it now avoids a painful migration when the claim
// workflow (and WhatsApp/email notifications) ships in a later phase. A claim is
// always anchored to the sale line that carries the warranty snapshot.
export const warrantyClaimTypeEnum = pgEnum('warranty_claim_type', [
  'exchange',
  'refund',
  'repair',
]);

export const warrantyClaimStatusEnum = pgEnum('warranty_claim_status', [
  'pending',
  'under_review',
  'approved',
  'rejected',
  'closed',
]);

export const warrantyClaimsSchema = pgTable(
  'warranty_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => salesSchema.id, { onDelete: 'restrict' }),
    saleItemId: uuid('sale_item_id')
      .notNull()
      .references(() => saleItemsSchema.id, { onDelete: 'restrict' }),
    type: warrantyClaimTypeEnum('type').notNull(),
    status: warrantyClaimStatusEnum('status').default('pending').notNull(),
    notes: text('notes'),
    resolution: text('resolution'),
    // Reserved for the deferred notification phase — kept nullable so the table
    // is forward-compatible without another migration.
    notificationId: uuid('notification_id'),
    createdBy: text('created_by'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { mode: 'date' }),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('warranty_claims_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
    index('warranty_claims_sale_idx').on(table.saleId),
    index('warranty_claims_sale_item_idx').on(table.saleItemId),
  ],
);

export const warrantyClaimsRelations = relations(
  warrantyClaimsSchema,
  ({ one }) => ({
    sale: one(salesSchema, {
      fields: [warrantyClaimsSchema.saleId],
      references: [salesSchema.id],
    }),
    saleItem: one(saleItemsSchema, {
      fields: [warrantyClaimsSchema.saleItemId],
      references: [saleItemsSchema.id],
    }),
  }),
);

// ── Smart Stock: stock_movements ledger ─────────────────────────────────────
// Append-only ledger of stock changes. type='entry' rows can carry expiresAt
// for perishable batches and feed the expiration-risk engine.
export const stockMovementTypeEnum = pgEnum('stock_movement_type', [
  'entry',
  'exit',
  'adjustment',
]);

export const stockMovementsSchema = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // FK with ON DELETE restrict — symmetric with sale_items. Makes the DB the
    // backstop for "you can't delete a product that has inventory history",
    // closing the orphan-movement race regardless of which path inserts a
    // movement. Safe to add: the codebase never hard-deleted products before, so
    // no orphan movements can exist.
    productId: uuid('product_id')
      .notNull()
      .references(() => productsSchema.id, { onDelete: 'restrict' }),
    productName: text('product_name'),
    type: stockMovementTypeEnum('type').notNull(),
    qty: integer('qty').notNull(),
    // For 'entry' rows: units of this batch still in stock (decremented by FIFO
    // on each exit). NULL means "not tracked per batch" (legacy or non-perishable).
    remainingQty: integer('remaining_qty'),
    unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
    // Only set when type='entry' and the product is perishable. The engine
    // sources daysToExpire from this column.
    expiresAt: date('expires_at'),
    reason: text('reason'),
    createdBy: text('created_by'),
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    supplierId: text('supplier_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('stock_movements_org_product_idx').on(
      table.organizationId,
      table.productId,
    ),
    // Partial index: only batches with an expiration date hit the lookup.
    index('stock_movements_expires_at_idx')
      .on(table.organizationId, table.productId, table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
  ],
);

// ── Smart Stock: expiration risk cache ─────────────────────────────────────
// One row per (organization, movement) UPSERTed by the daily cron. Lets the
// front-end paint tier badges without recomputing.
export const expirationRiskCacheSchema = pgTable(
  'expiration_risk_cache',
  {
    organizationId: text('organization_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    productId: uuid('product_id').notNull(),
    // Shape: { tier, riskRatio, daysToExpire, daysToSell, remainingQty,
    //          avgDaily, unitCost, salePrice, suggestedPct, suggestedPrice,
    //          maxSafePct, reasoning, classificationSource }
    payload: jsonb('payload').notNull(),
    computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  },
  table => [
    primaryKey({
      name: 'expiration_risk_cache_pk',
      columns: [table.organizationId, table.movementId],
    }),
    index('expiration_risk_cache_product_idx').on(
      table.organizationId,
      table.productId,
    ),
  ],
);

// ── Smart Stock: actionable discount suggestions ───────────────────────────
// "Gerenta IA" insists without nagging: a new suggestion only opens when the
// tier escalates or ≥3 days passed since rejection, capped at 3 reopens.
export const expirationTierEnum = pgEnum('expiration_tier', [
  'atencion',
  'urgente',
  'critico',
]);

export const expirationSuggestionStatusEnum = pgEnum(
  'expiration_suggestion_status',
  ['pending', 'accepted', 'rejected', 'superseded', 'expired'],
);

export const expirationSuggestionsSchema = pgTable(
  'expiration_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    productId: uuid('product_id').notNull(),
    tier: expirationTierEnum('tier').notNull(),
    suggestedPct: numeric('suggested_pct', { precision: 5, scale: 2 }).notNull(),
    maxSafePct: numeric('max_safe_pct', { precision: 5, scale: 2 }).notNull(),
    suggestedPrice: numeric('suggested_price', {
      precision: 12,
      scale: 2,
    }).notNull(),
    basePrice: numeric('base_price', { precision: 12, scale: 2 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 12, scale: 2 }).notNull(),
    reasoning: text('reasoning').notNull(),
    status: expirationSuggestionStatusEnum('status')
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { mode: 'date' }),
    resolvedBy: text('resolved_by'),
    reopenCount: integer('reopen_count').default(0).notNull(),
    notificationId: uuid('notification_id'),
    meta: jsonb('meta').default({}).notNull(),
  },
  table => [
    index('expiration_suggestions_movement_idx').on(
      table.organizationId,
      table.movementId,
      table.status,
    ),
    index('expiration_suggestions_pending_idx')
      .on(table.organizationId, table.status)
      .where(sql`${table.status} = 'pending'`),
    index('expiration_suggestions_product_idx').on(
      table.organizationId,
      table.productId,
      table.createdAt,
    ),
  ],
);

export const stockMovementsRelations = relations(
  stockMovementsSchema,
  ({ one }) => ({
    product: one(productsSchema, {
      fields: [stockMovementsSchema.productId],
      references: [productsSchema.id],
    }),
  }),
);

export const expirationSuggestionsRelations = relations(
  expirationSuggestionsSchema,
  ({ one }) => ({
    movement: one(stockMovementsSchema, {
      fields: [expirationSuggestionsSchema.movementId],
      references: [stockMovementsSchema.id],
    }),
    product: one(productsSchema, {
      fields: [expirationSuggestionsSchema.productId],
      references: [productsSchema.id],
    }),
  }),
);

export const paymentMethodTypeEnum = pgEnum('payment_method_type', [
  'cash',
  'transfer',
  'card',
  'credit',
  'other',
]);

// Per-organization catalog of payment methods used at checkout. Seeded with
// the Colombian defaults (Efectivo, Nequi, Daviplata, Llave, Tarjeta, Fiado)
// when the org first asks for them. Soft-deleted via active=false so audit
// trails on past sales (paymentType/method) still resolve.
export const paymentMethodsSchema = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    type: paymentMethodTypeEnum('type').notNull(),
    icon: text('icon'),
    active: boolean('active').default(true).notNull(),
    startHour: integer('start_hour'),
    endHour: integer('end_hour'),
    sortOrder: integer('sort_order').default(0).notNull(),
    details: jsonb('details').default({}).notNull(),
    description: text('description'),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('payment_methods_org_sort_idx').on(
      table.organizationId,
      table.sortOrder,
    ),
  ],
);

// ── Notifications ─────────────────────────────────────────────────────────
// Per-org notification feed (low stock, expiring batches, overdue fiados,
// cash-close discrepancies, generic sale alerts). Severity drives UI
// emphasis (e.g. red pulse on the bell for 'high').
export const notificationKindEnum = pgEnum('notification_kind', [
  'cash_difference',
  'low_stock',
  'expiring_soon',
  'fiado_overdue',
  'sale_alert',
]);

export const notificationSeverityEnum = pgEnum('notification_severity', [
  'low',
  'mid',
  'high',
]);

export const notificationsSchema = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    kind: notificationKindEnum('kind').notNull(),
    severity: notificationSeverityEnum('severity').default('mid').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    read: boolean('read').default(false).notNull(),
    payload: jsonb('payload').default({}).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('notifications_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('notifications_org_unread_idx')
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.read} = false`),
  ],
);

// ── Audit log ─────────────────────────────────────────────────────────────
// Append-only trail of mutations performed across the platform. Written by
// the `logAction` helper after every important server-action / API mutation
// (sales, returns, customer/product changes, cash open/close, employee
// invitations, plan upgrades, etc.).
//
// `before` / `after` are JSON snapshots; either can be null (a creation has
// no before, a deletion has no after). `actorType` distinguishes whose hand
// produced the change — a Clerk admin (`user`), a POS cashier (`cashier`),
// a cron job (`system`), or an external API/webhook (`api`).
export const auditActorTypeEnum = pgEnum('audit_actor_type', [
  'user',
  'cashier',
  'system',
  'api',
]);

export const auditLogsSchema = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata').default({}).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('audit_logs_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('audit_logs_org_action_idx').on(table.organizationId, table.action),
    index('audit_logs_org_entity_idx').on(
      table.organizationId,
      table.entityType,
      table.entityId,
    ),
    index('audit_logs_org_actor_idx').on(table.organizationId, table.actorId),
  ],
);

// Generic key/value store scoped per organization. Used by onboarding,
// feature flags, business profile, and any per-org preference that doesn't
// warrant its own table. Value is text — callers serialize JSON if needed.
export const appSettingsSchema = pgTable(
  'app_settings',
  {
    organizationId: text('organization_id').notNull(),
    key: text('key').notNull(),
    value: text('value').default('').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    primaryKey({
      name: 'app_settings_pk',
      columns: [table.organizationId, table.key],
    }),
  ],
);
