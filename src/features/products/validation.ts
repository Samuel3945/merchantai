import { z } from 'zod';

const decimalString = z
  .union([z.string(), z.number()])
  .transform(v => (typeof v === 'number' ? v.toString() : v))
  .refine(v => /^\d+(?:\.\d{1,2})?$/.test(v), {
    message: 'Must be a number with up to 2 decimals',
  });

const wholesaleTierSchema = z.object({
  minQty: z.coerce.number().int().positive(),
  price: decimalString,
});

export const productUnitType = z.enum(['unit', 'kg']);
export const productStatus = z.enum([
  'draft',
  'scheduled',
  'published',
  'archived',
]);

// Base fields shared by create and update. Initial-inventory fields live only on
// the create schema — they describe the opening stock batch, not editable later.
const productBaseSchema = z.object({
  name: z.string().min(1).max(200),
  barcode: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v)),
  price: decimalString,
  cost: decimalString.optional().default('0'),
  // No `stock` field on purpose: stock is owned by the FIFO ledger. It starts at
  // 0 and only grows via the opening batch (createProduct's initialQty) or an
  // inventory movement — never set absolutely from a product create/edit.
  category: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v)),
  unitType: productUnitType.optional().default('unit'),
  isPerishable: z.coerce.boolean().optional().default(false),
  isWholesale: z.coerce.boolean().optional().default(false),
  isDigital: z.coerce.boolean().optional().default(false),
  // Remaining sellable units for a digital product. NULL = unlimited.
  digitalLimit: z.coerce.number().int().min(0).nullable().optional(),
  wholesaleTiers: z.array(wholesaleTierSchema).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional().default({}),
  status: productStatus.optional().default('published'),
  publishAt: z.coerce.date().nullable().optional(),
});

// Wholesale tier consistency, scheduled-publish and opening-inventory rules,
// ported from Tiendademo's validateForm (products/types.ts).
function refineProduct(
  data: {
    price?: string;
    isWholesale?: boolean;
    wholesaleTiers?: { minQty: number; price: string }[] | null;
    status?: string;
    publishAt?: Date | null;
    isPerishable?: boolean;
    isDigital?: boolean;
    unitType?: string;
    initialQty?: number;
    initialCost?: string | null;
    initialExpiresAt?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const basePrice = data.price !== undefined ? Number(data.price) : Number.NaN;

  // Digital products have no physical inventory: they can't be weighed, can't
  // expire by lot, and never receive an opening stock batch.
  if (data.isDigital) {
    if (data.unitType === 'kg') {
      ctx.addIssue({ code: 'custom', path: ['unitType'], message: 'Un producto digital no se vende por peso' });
    }
    if (data.isPerishable) {
      ctx.addIssue({ code: 'custom', path: ['isPerishable'], message: 'Un producto digital no maneja vencimiento por lote' });
    }
    if ((data.initialQty ?? 0) > 0) {
      ctx.addIssue({ code: 'custom', path: ['initialQty'], message: 'Un producto digital no lleva inventario inicial' });
    }
  }

  if (data.isWholesale && data.wholesaleTiers && data.wholesaleTiers.length > 0) {
    const tiers = data.wholesaleTiers.map(t => ({
      q: t.minQty,
      p: Number(t.price),
    }));
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i]!;
      const path: (string | number)[] = ['wholesaleTiers', i];
      if (!Number.isFinite(t.q) || t.q < 2) {
        ctx.addIssue({ code: 'custom', path, message: `Tier ${i + 1}: cantidad ≥ 2` });
      }
      if (!Number.isFinite(t.p) || t.p <= 0) {
        ctx.addIssue({ code: 'custom', path, message: `Tier ${i + 1}: precio > 0` });
      }
      if (Number.isFinite(basePrice) && t.p >= basePrice) {
        ctx.addIssue({ code: 'custom', path, message: `Tier ${i + 1}: el precio mayorista debe ser menor al precio normal` });
      }
      if (i > 0 && t.q <= tiers[i - 1]!.q) {
        ctx.addIssue({ code: 'custom', path, message: 'Las cantidades deben ser estrictamente crecientes' });
      }
      if (i > 0 && t.p > tiers[i - 1]!.p) {
        ctx.addIssue({ code: 'custom', path, message: 'El precio por mayor debe bajar al subir la cantidad' });
      }
    }
  }

  if (data.status === 'scheduled' && !data.publishAt) {
    ctx.addIssue({ code: 'custom', path: ['publishAt'], message: 'Indica la fecha de publicación' });
  }

  const qty = data.initialQty ?? 0;
  if (qty > 0) {
    const cost = data.initialCost != null ? Number(data.initialCost) : Number.NaN;
    if (!Number.isFinite(cost) || cost <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['initialCost'],
        message: 'Si registras cantidad inicial, ingresa también el costo unitario de ingreso.',
      });
    }
    if (data.isPerishable && !data.initialExpiresAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['initialExpiresAt'],
        message: 'Este producto se vence: indica la fecha de caducidad de las unidades iniciales.',
      });
    }
  }
}

export const productCreateSchema = productBaseSchema
  .extend({
    // Opening inventory — optional. When initialQty > 0 the create action records
    // a FIFO entry movement (a batch) and bumps product stock atomically.
    initialQty: z.coerce.number().int().min(0).optional().default(0),
    initialCost: decimalString.nullable().optional(),
    initialExpiresAt: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .transform(v => (v === '' || v === undefined ? null : v)),
  })
  .superRefine(refineProduct);

// `stock` is not a field on the base schema (see note there), so an edit simply
// cannot touch it — stock is owned by inventory movements and the opening batch.
export const productUpdateSchema = productBaseSchema
  .partial()
  .superRefine(refineProduct);

export type ProductCreateInput = z.input<typeof productCreateSchema>;
export type ProductUpdateInput = z.input<typeof productUpdateSchema>;
