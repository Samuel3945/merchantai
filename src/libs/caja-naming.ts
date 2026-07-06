import type { db } from '@/libs/DB';
import { and, eq, sql } from 'drizzle-orm';
import { cajasSchema } from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Nombre secuencial "Caja N" para la próxima caja `register` de la org.
 * N = (cajas register existentes, INCLUYENDO archivadas) + 1, para que los
 * números nunca se reutilicen.
 *
 * Vive en un módulo NORMAL (no 'use server') a propósito: recibe un Executor
 * (db/tx) NO serializable, así que no puede ser un Server Action. Si se
 * exportara desde `actions/cajas.ts` ('use server'), pasarle `db` reventaría en
 * runtime (rompía la creación de dispositivos POS).
 */
export async function nextRegisterCajaName(
  executor: Executor,
  orgId: string,
): Promise<string> {
  const [row] = await executor
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cajasSchema)
    .where(
      and(
        eq(cajasSchema.organizationId, orgId),
        eq(cajasSchema.type, 'register'),
      ),
    );
  return `Caja ${Number(row?.count ?? 0) + 1}`;
}
