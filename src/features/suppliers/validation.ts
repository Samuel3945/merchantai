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

export const CONTACT_REQUIRED
  = 'Indica al menos un teléfono o un correo para poder contactar al proveedor';

// At least one way to reach the supplier. Enforced server-side so every flow
// that creates a supplier (Proveedores, Caja, inventory entry) yields a
// contactable row — the agent relies on this to request restocks.
function hasContact(d: { phone?: string | null; email?: string | null }) {
  return Boolean(d.phone) || Boolean(d.email);
}

const supplierBase = z.object({
  name: z.string().trim().min(1).max(200),
  company: optionalText(200),
  phone: optionalText(50),
  email: optionalText(200),
  city: optionalText(120),
  address: optionalText(500),
  taxId: optionalText(50),
  notes: optionalText(1000),
});

// Products this supplier provides, by id. Optional everywhere; on create it
// defaults to none, on update `undefined` means "leave assignments untouched".
const productIds = z.array(z.string().uuid());

export const supplierCreateSchema = supplierBase
  .extend({ productIds: productIds.optional().default([]) })
  .refine(hasContact, { message: CONTACT_REQUIRED, path: ['phone'] });

export const supplierUpdateSchema = supplierBase
  .partial()
  .extend({ productIds: productIds.optional() })
  .refine(
    // Only enforce the contact rule when this update actually touches contact
    // fields; a name-only or products-only update should not be blocked.
    d => (d.phone === undefined && d.email === undefined ? true : hasContact(d)),
    { message: CONTACT_REQUIRED, path: ['phone'] },
  );

export type SupplierCreateInput = z.input<typeof supplierCreateSchema>;
export type SupplierUpdateInput = z.input<typeof supplierUpdateSchema>;
