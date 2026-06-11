import { NextResponse } from 'next/server';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Acuse de un comando remoto por parte del dispositivo. Sin infra de comandos
 * todavía (ver pending-commands), aceptamos el ack como no-op autenticado para
 * mantener el contrato del cajero satisfecho.
 */
export async function POST(
  req: Request,
  _ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  return NextResponse.json({ ok: true });
}
