import type { NextFetchEvent, NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
import { resolveCashierSession } from '@/libs/cashier-session';
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

async function handlePosRequest(request: NextRequest) {
  if (POS_AUTH_FREE_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const sessionId = request.headers.get('x-session-id');
  if (!sessionId) {
    return NextResponse.json(
      { error: 'missing_session' },
      { status: 401 },
    );
  }

  const session = await resolveCashierSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: 'invalid_session' },
      { status: 401 },
    );
  }

  const forwarded = new Headers(request.headers);
  forwarded.set('x-pos-user-id', session.user.id);
  forwarded.set('x-pos-user-role', session.user.role);
  forwarded.set('x-pos-organization-id', session.user.organizationId);

  return NextResponse.next({ request: { headers: forwarded } });
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

      // Redirect authenticated users without an organization to the organization selection page
      // This ensures users are properly associated with an organization before accessing the dashboard
      if (
        authObj.userId
        && !authObj.orgId
        && req.nextUrl.pathname.includes('/dashboard')
        && !req.nextUrl.pathname.endsWith('/organization-selection')
      ) {
        const orgSelection = new URL(
          '/onboarding/organization-selection',
          req.url,
        );

        return NextResponse.redirect(orgSelection);
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
