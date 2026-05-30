import { NextResponse } from 'next/server';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Comandos remotos pendientes para el dispositivo (bloquear, recargar, etc.).
 * MerchantAI aún no tiene infra de comandos remotos en el schema, así que
 * devolvemos lista vacía: el ciclo de vida del cajero hace polling sin error
 * y la pantalla de "bloqueado" nunca se dispara por accidente.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(req.headers.get('authorization'));
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  return NextResponse.json([]);
}
