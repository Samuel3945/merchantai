import { NextResponse } from 'next/server';
import { touchLastSync } from '@/actions/pos-tokens';
import { resolvePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Latido del dispositivo POS (cada ~15s). Confirma que el Bearer token sigue
 * vivo y refresca `lastSyncAt` para el panel de "POS Cajeros". Sin infra de
 * comandos remotos todavía: solo acusa estar online.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  const ctx = await resolvePosAuth(authHeader);
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  // Solo los tokens de dispositivo tienen fila en pos_tokens; para sesiones de
  // usuario (cajero por PIN) el update no afecta filas y es inocuo.
  if (ctx.source === 'token') {
    const token = /^Bearer\s+(\S.*)$/i.exec(authHeader ?? '')?.[1]?.trim();
    if (token) {
      try {
        await touchLastSync(token);
      } catch {
        // Latido best-effort: nunca debe tumbar al cajero.
      }
    }
  }

  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
