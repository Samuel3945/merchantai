import { z } from 'zod';

const decimalString = z
  .union([z.string(), z.number()])
  .transform(v => (typeof v === 'number' ? v.toString() : v))
  .refine(v => /^\d+(\.\d{1,2})?$/.test(v), {
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

export const productCreateSchema = z.object({
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
  stock: z.coerce.number().int().min(0).optional().default(0),
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
  wholesaleTiers: z.array(wholesaleTierSchema).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional().default({}),
  status: productStatus.optional().default('published'),
  publishAt: z.coerce.date().nullable().optional(),
});

export const productUpdateSchema = productCreateSchema.partial();

export type ProductCreateInput = z.input<typeof productCreateSchema>;
export type ProductUpdateInput = z.input<typeof productUpdateSchema>;
