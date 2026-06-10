import type { NextFetchEvent, NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
import { resolveCashierSession } from '@/libs/cashier-session';
import { getPanelUserModules } from '@/libs/panel-session';
import { requiredModuleForPath } from '@/libs/permissions';
import { routing } from './libs/I18nRouting';

// Cashier auth needs pg + bcrypt at the edge of /api/pos/*, which are Node-only.
// Note: Next.js 16 proxy files always run on Node.js runtime — declaration not needed.

const handleI18nRouting = createMiddleware(routing);

const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/:locale/dashboard(.*)',
  '/onboarding(.*)',
  '/:locale/onboarding(.*)',
]);

const isAuthPage = createRouteMatcher([
  '/sign-in(.*)',
  '/:locale/sign-in(.*)',
  '/sign-up(.*)',
  '/:locale/sign-up(.*)',
]);

const POS_AUTH_FREE_PATHS = new Set([
  '/api/pos/auth/login',
  '/api/pos/auth/logout',
]);

// Endpoints que un dispositivo POS externo (TiendaCajero) llama ANTES de tener
// Bearer token: el login (code+PIN o token) y el connect (bootstrap por token).
// Su autenticación la resuelve el propio handler, no la sesión del proxy.
const POS_DEVICE_FREE_PATHS = new Set([
  '/api/pos/login',
  '/api/pos/connect',
]);

// Orígenes del POS de cajero autorizados a llamar /api/pos/* cross-origin.
// (TiendaCajero corre en su propio dominio Vercel; el navegador exige CORS.)
const POS_ALLOWED_ORIGINS = [
  'https://app.pos.mymerchantai.com',
  'https://mechantai-pos-merchantai.kmy1zc.easypanel.host',
  'https://app.pos.merchantai.com',
  'https://pos-cajero.vercel.app',
  'http://localhost:5174',
  'http://localhost:5173',
];

function posCorsHeaders(origin: string | null): Record<string, string> {
  const allow
    = origin && POS_ALLOWED_ORIGINS.includes(origin)
      ? origin
      : POS_ALLOWED_ORIGINS[0]!;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, x-session-id, x-pos-cashier-id, x-pos-session-epoch',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function hasBearer(request: NextRequest): boolean {
  return (
    request.headers.get('authorization')?.toLowerCase().startsWith('bearer ')
    ?? false
  );
}

async function handlePosRequest(request: NextRequest) {
  const cors = posCorsHeaders(request.headers.get('origin'));

  const withCors = (res: NextResponse): NextResponse => {
    for (const [key, value] of Object.entries(cors)) {
      res.headers.set(key, value);
    }
    return res;
  };

  // Preflight CORS — responder antes de tocar auth.
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // Sesión del cajero embebido en el admin (login/logout) sin auth previa.
  if (POS_AUTH_FREE_PATHS.has(request.nextUrl.pathname)) {
    return withCors(NextResponse.next());
  }

  // Dispositivos POS externos: el login/connect van sin token, y el resto de
  // sus rutas viajan con Bearer token que el handler valida vía resolvePosAuth.
  // En ambos casos el proxy solo deja pasar (no exige x-session-id).
  if (POS_DEVICE_FREE_PATHS.has(request.nextUrl.pathname) || hasBearer(request)) {
    return withCors(NextResponse.next());
  }

  const sessionId = request.headers.get('x-session-id');
  if (!sessionId) {
    return withCors(
      NextResponse.json({ error: 'missing_session' }, { status: 401 }),
    );
  }

  const session = await resolveCashierSession(sessionId);
  if (!session) {
    return withCors(
      NextResponse.json({ error: 'invalid_session' }, { status: 401 }),
    );
  }

  const forwarded = new Headers(request.headers);
  forwarded.set('x-pos-user-id', session.user.id);
  forwarded.set('x-pos-user-role', session.user.role);
  forwarded.set('x-pos-organization-id', session.user.organizationId);

  return withCors(NextResponse.next({ request: { headers: forwarded } }));
}

export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  // Cashier endpoints run completely outside Clerk — Clerk owns org admins,
  // pos_users own cashiers / employees. Short-circuit before Clerk + i18n.
  if (pathname.startsWith('/api/pos/')) {
    return handlePosRequest(request);
  }

  // All other /api/* (cron, ai, expiration, notifications, webhooks, upload,
  // organizations, settings, invitations) handle their own auth and must NOT
  // be rewritten by next-intl, otherwise they 404 under the locale prefix.
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Clerk keyless mode doesn't work with i18n, this is why we need to run the middleware conditionally
  if (
    isAuthPage(request) || isProtectedRoute(request)
  ) {
    return clerkMiddleware(async (auth, req) => {
      // Check if the current route is protected and requires authentication
      // If user is not authenticated, redirect them to the sign-in page with proper locale
      if (isProtectedRoute(req)) {
        const locale = req.nextUrl.pathname.match(/(\/.*)\/dashboard/)?.at(1) ?? '';

        const signInUrl = new URL(`${locale}/sign-in`, req.url);

        await auth.protect({
          unauthenticatedUrl: signInUrl.toString(),
        });
      }

      const authObj = await auth();

      // Authenticated users without an active organization belong in the
      // onboarding wizard — its first step creates the org programmatically, so
      // we no longer bounce them to Clerk's create-organization screen. The
      // wizard renders fine without an org; only /dashboard needs one, so we
      // keep that redirect. /onboarding and /organization-selection stay
      // reachable (the latter is still used to switch between businesses).
      if (
        authObj.userId
        && !authObj.orgId
        && req.nextUrl.pathname.includes('/dashboard')
      ) {
        const onboardingUrl = new URL('/onboarding', req.url);

        return NextResponse.redirect(onboardingUrl);
      }

      // Deny-by-default panel authorization for non-owner members. They may open
      // the Resumen landing and only the dashboard modules they were granted;
      // anything else (owner-only views or unmapped routes) bounces to /dashboard.
      // The DB is the source of truth (the Clerk metadata is only a cache).
      if (
        authObj.userId
        && authObj.orgId
        && authObj.orgRole === 'org:member'
        && req.nextUrl.pathname.includes('/dashboard')
      ) {
        const need = requiredModuleForPath(req.nextUrl.pathname);
        if (need.kind !== 'public') {
          const modules = await getPanelUserModules(
            authObj.userId,
            authObj.orgId,
          );
          const allowed
            = need.kind === 'module'
              && (modules?.includes(need.module) ?? false);
          if (!allowed) {
            return NextResponse.redirect(new URL('/dashboard', req.url));
          }
        }
      }

      return handleI18nRouting(req);
    })(request, event);
  }

  return handleI18nRouting(request);
}

export const config = {
  // Match all pathnames except for
  // - … if they start with `/_next`, `/_vercel` or `monitoring`
  // - … the ones containing a dot (e.g. `favicon.ico`)
  matcher: ['/((?!_next|_vercel|monitoring|.*\\..*).*)', '/api/pos/:path*'],
};
