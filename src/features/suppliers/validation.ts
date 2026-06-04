import { z } from 'zod';

// Reusable optional text field: trims, caps length, and normalizes empty/absent
// to null so the DB never stores empty strings.
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v));
}

export const supplierCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  company: optionalText(200),
  phone: optionalText(50),
  email: optionalText(200),
  city: optionalText(120),
  address: optionalText(500),
  taxId: optionalText(50),
  notes: optionalText(1000),
});

export const supplierUpdateSchema = supplierCreateSchema.partial();

export type SupplierCreateInput = z.input<typeof supplierCreateSchema>;
export type SupplierUpdateInput = z.input<typeof supplierUpdateSchema>;
