import { and, asc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { validatePosToken } from '@/actions/pos-tokens';
import { db } from '@/libs/DB';
import { orgAddressesSchema, posUsersSchema, productsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ConnectBody = { token?: string };

async function getSetting(
  organizationId: string,
  key: string,
): Promise<string> {
  try {
    const result = await db.execute<{ value: string | null }>(
      sql`SELECT value FROM app_settings WHERE organization_id = ${organizationId} AND key = ${key} LIMIT 1`,
    );
    return result.rows[0]?.value ?? '';
  } catch {
    return '';
  }
}

async function listActivePaymentMethods(organizationId: string) {
  try {
    const result = await db.execute(
      sql`SELECT id, name, type, icon, active, sort_order, details, description
          FROM payment_methods
          WHERE organization_id = ${organizationId} AND active = true
          ORDER BY sort_order`,
    );
    return result.rows;
  } catch {
    return [];
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json(
      { valid: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json(
      { valid: false, error: 'token is required' },
      { status: 400 },
    );
  }

  let posToken;
  try {
    posToken = await validatePosToken(token);
  } catch (err) {
    return NextResponse.json(
      {
        valid: false,
        error: err instanceof Error ? err.message : 'Invalid token',
      },
      { status: 401 },
    );
  }

  const orgId = posToken.organizationId;

  const [businessName, businessAddress, fiadoEnabledRaw, paymentMethods, products, cashierRow, branchRows]
    = await Promise.all([
      getSetting(orgId, 'business_name'),
      getSetting(orgId, 'business_address'),
      getSetting(orgId, 'fiado-enabled'),
      listActivePaymentMethods(orgId),
      db
        .select()
        .from(productsSchema)
        .where(
          and(
            eq(productsSchema.organizationId, orgId),
            eq(productsSchema.deleted, false),
          ),
        )
        .orderBy(asc(productsSchema.name)),
      posToken.cashierId
        ? db
            .select({ id: posUsersSchema.id, name: posUsersSchema.name })
            .from(posUsersSchema)
            .where(eq(posUsersSchema.id, posToken.cashierId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        : Promise.resolve(null),
      // Branch address for THIS caja. Multi-branch is per posToken.
      posToken.addressId
        ? db
            .select({
              address: orgAddressesSchema.address,
              city: orgAddressesSchema.city,
            })
            .from(orgAddressesSchema)
            .where(eq(orgAddressesSchema.id, posToken.addressId))
            .limit(1)
        : Promise.resolve([]),
    ]);

  const fiadoEnabled = fiadoEnabledRaw === 'true';

  // Caja branch address if assigned, else the legacy global business_address.
  const branch = branchRows[0];
  const storeAddress = branch
    ? [branch.address, branch.city].filter(Boolean).join(', ')
    : businessAddress || '';

  // El método "Fiado" (type credit) se controla por el toggle fiado-enabled, no
  // por su columna active. Si el toggle está apagado, no debe llegar al cajero
  // como opción de pago aunque la fila siga active = true.
  const visiblePaymentMethods = fiadoEnabled
    ? paymentMethods
    : paymentMethods.filter(
        pm => (pm as { type?: string }).type !== 'credit',
      );

  return NextResponse.json({
    valid: true,
    store: {
      id: posToken.storeId,
      name: businessName || 'Mi Tienda',
      address: storeAddress,
      fiadoEnabled,
    },
    cashier: cashierRow ? { id: cashierRow.id, name: cashierRow.name } : null,
    paymentMethods: visiblePaymentMethods,
    products,
  });
}
