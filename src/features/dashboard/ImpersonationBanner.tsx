import { auth } from '@clerk/nextjs/server';

/**
 * Visible marker for Clerk-impersonated sessions (support access started from
 * the platform console). Clerk encodes the real operator in the session's
 * `act` claim; when it is present this session is NOT the business owner.
 */
export async function ImpersonationBanner() {
  const { sessionClaims } = await auth();
  const actor = (sessionClaims as { act?: { sub?: string } } | null)?.act;

  if (!actor?.sub) {
    return null;
  }

  return (
    <div className="
      border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm
      font-medium text-amber-900
    "
    >
      Sesión de soporte activa: estás navegando este negocio como soporte de la
      plataforma. Cerrá sesión al terminar.
    </div>
  );
}
