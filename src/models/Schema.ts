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

// How a category came to exist: 'manual' (owner typed/created it), 'ai' (an LLM
// suggestion was accepted) or 'auto' (created on the fly when a product was
// assigned a name not yet seen). Drives trust/ranking later.
export const categorySourceEnum = pgEnum('category_source', [
  'manual',
  'ai',
  'auto',
]);

// Per-org product categories. Categories are DYNAMIC: a row is created on demand
// the first time a product is assigned a name (see actions#upsertCategory) and
// ranked by usageCount. `attributeTemplate` is the learned set of characteristic
// keys typical for this category in THIS org (populated by a later slice) — the
// basis for "characterization that varies with the products that come in".
// `products.category` (text) is kept as a denormalized cache alongside the FK.
export const categoriesSchema = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    // Normalized key (lowercased, trimmed) so "Bebidas" and "bebidas" collapse
    // to one category per org.
    slug: text('slug').notNull(),
    source: categorySourceEnum('source').default('auto').notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    attributeTemplate: jsonb('attribute_template')
      .$type<{ key: string; count: number }[]>()
      .default([])
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('categories_org_slug_unique_idx').on(
      table.organizationId,
      table.slug,
    ),
    index('categories_org_usage_idx').on(
      table.organizationId,
      table.usageCount,
    ),
  ],
);

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
    // Denormalized category name (cache for cheap reads) + normalized FK. Both
    // are kept in sync by createProduct/updateProduct via upsertCategory.
    category: text('category'),
    categoryId: uuid('category_id').references(() => categoriesSchema.id, {
      onDelete: 'set null',
    }),
    unitType: productUnitTypeEnum('unit_type').default('unit').notNull(),
    isPerishable: boolean('is_perishable').default(false).notNull(),
    isWholesale: boolean('is_wholesale').default(false).notNull(),
    wholesaleTiers: jsonb('wholesale_tiers'),
    attributes: jsonb('attributes').default({}).notNull(),
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

// Per-org business-intelligence snapshot — PLATFORM-level analytics, never shown
// to the shop. Materialized (one row per org) and recomputed deterministically
// from products/sales/stock_movements/categories by libs/business-profile.ts (no
// LLM, same philosophy as smart-stock). Captures what kinds of businesses use the
// software, how big, and how they sell, for later analysis. All counts/sums are
// recomputed wholesale so the snapshot can't drift.
export const businessProfileSchema = pgTable('business_profile', {
  organizationId: text('organization_id').primaryKey(),
  // Catalog shape.
  productCount: integer('product_count').default(0).notNull(),
  activeProductCount: integer('active_product_count').default(0).notNull(),
  perishableCount: integer('perishable_count').default(0).notNull(),
  wholesaleCount: integer('wholesale_count').default(0).notNull(),
  distinctCategories: integer('distinct_categories').default(0).notNull(),
  totalStockUnits: integer('total_stock_units').default(0).notNull(),
  avgPrice: numeric('avg_price', { precision: 12, scale: 2 }),
  minPrice: numeric('min_price', { precision: 12, scale: 2 }),
  maxPrice: numeric('max_price', { precision: 12, scale: 2 }),
  // Commerce, rolling 30-day window.
  unitsSold30d: integer('units_sold_30d').default(0).notNull(),
  salesCount30d: integer('sales_count_30d').default(0).notNull(),
  distinctProductsSold30d: integer('distinct_products_sold_30d')
    .default(0)
    .notNull(),
  purchaseEvents30d: integer('purchase_events_30d').default(0).notNull(),
  // Derived.
  topCategories: jsonb('top_categories')
    .$type<{ name: string; usageCount: number }[]>()
    .default([])
    .notNull(),
  // Coarse v1 classification from objective ratios (refinable later from the
  // stored signals): 'grocery_fresh' | 'wholesale' | 'retail_general' | null.
  inferredBusinessType: text('inferred_business_type'),
  computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

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
    // DIAN e-invoicing intent + result, mirrored onto the sale for cheap reads.
    // Every sale starts 'pending' so it surfaces in the Facturas module; it
    // flips to 'emitted' (with cufe/number) or 'failed' once a provider runs.
    // The authoritative emission trail lives in `einvoice_emissions`.
    einvoiceStatus: text('einvoice_status').default('pending').notNull(),
    einvoiceCufe: text('einvoice_cufe'),
    einvoiceNumber: text('einvoice_number'),
    einvoiceId: uuid('einvoice_id'),
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
  // Cobro de fiado: a customer pays down a credit account IN CASH. It is drawer
  // income for the arqueo, but it is NOT new revenue (the sale already booked
  // revenue when the fiado was created) — so Finanzas excludes it. Only the
  // efectivo portion lands here; digital abonos (nequi/daviplata/transfer) are
  // recorded on the fiado ledger but never touch the physical drawer.
  'fiado_payment',
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
    // Web panel access. The employee is ONE business user; Clerk is only the web
    // identity provider. `clerkUserId` links this single user to their Clerk
    // account (null when POS-only). `panelAccess` is INDEPENDENT from module
    // grants: it only decides whether the user can sign into the web panel at
    // all — which views they see once inside is governed by `enabledModules`.
    clerkUserId: text('clerk_user_id'),
    panelAccess: boolean('panel_access').default(false).notNull(),
    // Incremented on each successful password login. Same single-active-device
    // mechanism as pos_tokens.session_epoch: if the client's known epoch is lower
    // than the stored one, the session is considered revoked.
    sessionEpoch: integer('session_epoch').default(0).notNull(),
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
    // Carried to the accept step so it knows whether to provision a Clerk web
    // identity for this single user.
    panelAccess: boolean('panel_access').default(false).notNull(),
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

// Operator-managed plan catalog. Single source of truth for what each plan
// costs and grants — replaces the hardcoded PLAN_* maps that used to live in
// actions/plans.ts, actions/pos-tokens.ts and actions/employees.ts. Plans are
// created/edited at runtime from the platform console; tenant code resolves an
// org's effective limits through libs/entitlements.ts, never by reading this
// table with a hardcoded slug.
export const plansSchema = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable identifier stored in subscriptions.plan ('free', 'pro', ...).
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    priceMonthlyCop: numeric('price_monthly_cop', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Null means the plan has no annual option.
    priceAnnualCop: numeric('price_annual_cop', { precision: 12, scale: 2 }),
    // Marketing bullets rendered on the tenant plans page.
    featureBullets: jsonb('feature_bullets')
      .$type<string[]>()
      .default([])
      .notNull(),
    // Public plans appear on the tenant plans page; hidden ones are
    // operator-assigned only (custom deals, grandfathered tiers).
    isPublic: boolean('is_public').default(true).notNull(),
    // The plan an org falls back to when it has no active subscription.
    isDefault: boolean('is_default').default(false).notNull(),
    // Archived plans keep historical subscriptions resolvable but cannot be
    // selected for new upgrades.
    isArchived: boolean('is_archived').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('plans_slug_unique_idx').on(table.slug),
    uniqueIndex('plans_one_default_idx')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
  ],
);

// What each plan grants. Numeric limits use the value directly
// (max_cashiers, ai_credits_sales_manager, ...); boolean features use 0/1
// (feature_smart_stock, ...). One row per (plan, key).
export const planEntitlementsSchema = pgTable(
  'plan_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plansSchema.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: integer('value').default(0).notNull(),
  },
  table => [
    uniqueIndex('plan_entitlements_plan_key_unique_idx').on(
      table.planId,
      table.key,
    ),
  ],
);

// Operator-curated metadata about each business, maintained from the platform
// console: lifecycle status, free-form tags/groups for segmentation, internal
// notes and known issues. Never visible to the tenant.
export const platformOrgMetadataSchema = pgTable('platform_org_metadata', {
  organizationId: text('organization_id').primaryKey(),
  // Lifecycle bucket: none | trial | vip | at_risk | churned.
  status: text('status').default('none').notNull(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  groupName: text('group_name'),
  notes: text('notes'),
  knownIssues: text('known_issues'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Per-organization plan tier. Drives quota for cashiers, etc.
// DEPRECATED: never written by app code (upgrade flows only write
// `subscriptions`), which silently kept paying orgs on free-tier cashier
// limits. Readers now go through libs/entitlements.ts; this table stays only
// so existing rows remain queryable until it is dropped.
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

// ── Fiados (store-credit accounts) ─────────────────────────────────────────
// A fiado is a first-class receivable: the customer took goods now and pays
// later. It replaces the old "derived from sales.notes" hack — see
// actions/fiados.ts. The account holds the headline figures (original amount,
// due date, status); fiado_movements is the append-only ledger that records
// every charge, payment, plazo extension and adjustment chronologically. That
// ledger IS the timeline shown in the detail view and the full audit trail.
//
// Balance = original_amount − SUM(payment movements). A fiado is `paid` when the
// balance reaches zero and `written_off` when forgiven. Rows are never deleted,
// so the Historial tab always has the complete record.
export const fiadoStatusEnum = pgEnum('fiado_status', [
  'pending',
  'paid',
  'written_off',
]);

export const fiadoMovementTypeEnum = pgEnum('fiado_movement_type', [
  // Origin of the debt — one per fiado, amount = original_amount.
  'charge',
  // Customer pays down the balance (efectivo/nequi/daviplata/transferencia/otro).
  'payment',
  // Plazo extended — carries due_date_before / due_date_after for the audit.
  'extension',
  // Debt forgiven.
  'writeoff',
  // Manual correction (e.g. a return that reduces what is owed).
  'adjustment',
]);

export const fiadosSchema = pgTable(
  'fiados',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Linked once the notes-regex identity is replaced by a real customer FK.
    // SET NULL (not cascade): archiving a customer must never wipe the debt.
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    // Origin sale. SET NULL keeps the fiado alive even if the sale is purged;
    // the unique index below makes the backfill idempotent (one fiado per sale).
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    originalAmount: numeric('original_amount', {
      precision: 12,
      scale: 2,
    }).notNull(),
    // The real payment deadline — the field the old model never stored. Used by
    // Vencido / Próximo a vencer / "Vence mañana" and the Caja-free risk states.
    dueDate: date('due_date').notNull(),
    status: fiadoStatusEnum('status').default('pending').notNull(),
    // Display continuity during migration: holds the parsed "name | Tel: phone"
    // until customer_id is fully populated.
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // Pendientes/Historial tabs and the dashboard counts filter org + status.
    index('fiados_org_status_idx').on(table.organizationId, table.status),
    // Vencidos / Próximos a vencer scan org + due_date.
    index('fiados_org_due_date_idx').on(table.organizationId, table.dueDate),
    index('fiados_customer_idx').on(table.customerId),
    // One fiado per origin sale. Lets the backfill be re-run safely to catch
    // fiados created between Phase 0 and the Phase 1 write path going live.
    uniqueIndex('fiados_sale_unique_idx')
      .on(table.saleId)
      .where(sql`${table.saleId} IS NOT NULL`),
  ],
);

export const fiadoMovementsSchema = pgTable(
  'fiado_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fiadoId: uuid('fiado_id')
      .notNull()
      .references(() => fiadosSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: fiadoMovementTypeEnum('type').notNull(),
    // Always positive; `type` decides the direction. Zero for pure extensions.
    amount: numeric('amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Set on payments only. Null for charge/extension.
    method: text('method'),
    // Links a cash (efectivo) payment to the Caja drawer movement it created.
    // Null for digital payments (nequi/daviplata/transferencia) — those are
    // collected but must NOT inflate the physical-cash arqueo. SET NULL so the
    // ledger survives if the cash movement is ever removed.
    cashMovementId: uuid('cash_movement_id').references(
      () => cashMovementsSchema.id,
      { onDelete: 'set null' },
    ),
    // Plazo-extension audit: the deadline before and after the change.
    dueDateBefore: date('due_date_before'),
    dueDateAfter: date('due_date_after'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // The timeline: every movement of a fiado, oldest first.
    index('fiado_movements_fiado_created_idx').on(
      table.fiadoId,
      table.createdAt,
    ),
    // "Recuperado este mes" and the digital-vs-cash report split scan
    // org + type + time window.
    index('fiado_movements_org_type_created_idx').on(
      table.organizationId,
      table.type,
      table.createdAt,
    ),
  ],
);

export const fiadosRelations = relations(fiadosSchema, ({ one, many }) => ({
  customer: one(customersSchema, {
    fields: [fiadosSchema.customerId],
    references: [customersSchema.id],
  }),
  sale: one(salesSchema, {
    fields: [fiadosSchema.saleId],
    references: [salesSchema.id],
  }),
  movements: many(fiadoMovementsSchema),
}));

export const fiadoMovementsRelations = relations(
  fiadoMovementsSchema,
  ({ one }) => ({
    fiado: one(fiadosSchema, {
      fields: [fiadoMovementsSchema.fiadoId],
      references: [fiadosSchema.id],
    }),
    cashMovement: one(cashMovementsSchema, {
      fields: [fiadoMovementsSchema.cashMovementId],
      references: [cashMovementsSchema.id],
    }),
  }),
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
  // stock; 'damaged' | 'discard' are audit-only and never touch inventory.
  // `restock` stays in sync (true iff disposition === 'restock').
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
    // Free-text detail. REQUIRED when reason='manual' ("Otro motivo") so every
    // off-book adjustment — initial inventory, count shortfall/surplus, returns
    // to supplier, in-shop consumption — carries an auditable explanation.
    notes: text('notes'),
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
  // Operator broadcast from the platform console (announcements, maintenance,
  // incidents). Rendered with a generic icon and no deep link.
  'platform_announcement',
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

// ── DIAN e-invoicing emissions ──────────────────────────────────────────────
// Append-only audit trail of every attempt to emit an electronic document for a
// sale through a provider (currently Factus). One sale can have several rows: a
// failed attempt then a successful retry (kind 'invoice'), plus a 'credit_note'
// when the sale is later returned. The provider adapter writes the request
// `payload` and raw `response` here so a failed emission is fully debuggable.
// `sales.einvoice_*` mirrors the latest successful invoice for cheap listing.
export const einvoiceEmissionsSchema = pgTable(
  'einvoice_emissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => salesSchema.id, { onDelete: 'cascade' }),
    // 'invoice' | 'credit_note'
    kind: text('kind').default('invoice').notNull(),
    // 'factus' for now; the column lets a second adapter coexist later.
    provider: text('provider').default('factus').notNull(),
    // 'queued' | 'sent' | 'emitted' | 'failed'
    status: text('status').default('queued').notNull(),
    providerId: text('provider_id'),
    cufe: text('cufe'),
    number: text('number'),
    customer: jsonb('customer'),
    payload: jsonb('payload'),
    response: jsonb('response'),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    emittedAt: timestamp('emitted_at', { mode: 'date' }),
  },
  table => [
    index('einvoice_emissions_org_sale_idx').on(
      table.organizationId,
      table.saleId,
    ),
    index('einvoice_emissions_sale_kind_created_idx').on(
      table.saleId,
      table.kind,
      table.createdAt,
    ),
  ],
);

// ── Domicilios (delivery orders) ────────────────────────────────────────────
// A delivery_order is what the courier ("domiciliario") sees and acts on: an
// order to carry to an address. The AI agent (WhatsApp intake) or the POS
// create it; the courier moves it through the status state machine and the
// customer is notified on each transition. `delivery_events` is the append-only
// ledger of everything that happened to the order (status changes, notes,
// outbound notifications) — it mirrors the fiado_movements pattern and IS the
// "Historial" the courier view renders.
//
// State machine: pending → assigned → in_transit → delivered
//                (any non-terminal) → cancelled
// A cancellation (customer regrets the purchase) flips status to 'cancelled',
// which drops the order from the courier's active board and triggers a notify.
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'assigned',
  'in_transit',
  'delivered',
  'cancelled',
]);

export const deliveryOrdersSchema = pgTable(
  'delivery_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Linked customer (holds the WhatsApp number used for notifications). SET
    // NULL so archiving a customer never wipes the delivery history.
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    // Set when a delivered order auto-generates a sale, or when it originated
    // from a POS sale. SET NULL keeps the delivery row if the sale is purged.
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    // Assigned courier (a pos_user). SET NULL so removing an employee never
    // deletes the order; it just becomes unassigned.
    courierId: uuid('courier_id').references(() => posUsersSchema.id, {
      onDelete: 'set null',
    }),
    status: deliveryStatusEnum('status').default('pending').notNull(),
    // Denormalized snapshot so the courier view renders without extra joins and
    // survives even if the customer record later changes.
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    address: text('address').notNull(),
    addressNotes: text('address_notes'),
    // What to deliver: [{ name, qty, price }]. A snapshot (not FKs) so the
    // courier always sees what was agreed even if products change later.
    items: jsonb('items').default([]).notNull(),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    deliveryFee: numeric('delivery_fee', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    total: numeric('total', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Where the order came from: 'manual' | 'ai_agent' | 'pos'. Lets us tell
    // agent-created orders apart and drive analytics.
    source: text('source').default('manual').notNull(),
    notes: text('notes'),
    assignedAt: timestamp('assigned_at', { mode: 'date' }),
    inTransitAt: timestamp('in_transit_at', { mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { mode: 'date' }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // The courier board and admin list filter org + status, newest first.
    index('delivery_orders_org_status_created_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    // "My deliveries" for a courier scans org + courier.
    index('delivery_orders_org_courier_idx').on(
      table.organizationId,
      table.courierId,
    ),
    index('delivery_orders_customer_idx').on(table.customerId),
  ],
);

export const deliveryEventTypeEnum = pgEnum('delivery_event_type', [
  'created',
  'assigned',
  'status_change',
  'note',
  'customer_notified',
]);

export const deliveryEventsSchema = pgTable(
  'delivery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryOrderId: uuid('delivery_order_id')
      .notNull()
      .references(() => deliveryOrdersSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: deliveryEventTypeEnum('type').notNull(),
    // Set for status_change rows: the transition recorded.
    fromStatus: deliveryStatusEnum('from_status'),
    toStatus: deliveryStatusEnum('to_status'),
    note: text('note'),
    // Who produced the event — courier (cashier), admin (user), agent (api),
    // cron (system). Reuses the audit actor vocabulary.
    actorType: auditActorTypeEnum('actor_type').default('user').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // The timeline: every event of an order, oldest first.
    index('delivery_events_order_created_idx').on(
      table.deliveryOrderId,
      table.createdAt,
    ),
  ],
);

export const deliveryOrdersRelations = relations(
  deliveryOrdersSchema,
  ({ one, many }) => ({
    customer: one(customersSchema, {
      fields: [deliveryOrdersSchema.customerId],
      references: [customersSchema.id],
    }),
    sale: one(salesSchema, {
      fields: [deliveryOrdersSchema.saleId],
      references: [salesSchema.id],
    }),
    courier: one(posUsersSchema, {
      fields: [deliveryOrdersSchema.courierId],
      references: [posUsersSchema.id],
    }),
    events: many(deliveryEventsSchema),
  }),
);

export const deliveryEventsRelations = relations(
  deliveryEventsSchema,
  ({ one }) => ({
    order: one(deliveryOrdersSchema, {
      fields: [deliveryEventsSchema.deliveryOrderId],
      references: [deliveryOrdersSchema.id],
    }),
  }),
);
