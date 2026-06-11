'use server';

import type { ActionResult } from '@/libs/action-result';
import { clerkClient } from '@clerk/nextjs/server';
import { logAction } from '@/libs/audit-log';
import { requirePlatformOperator } from '@/libs/platform/operator';

/**
 * Support impersonation via Clerk's native actor tokens. The operator gets a
 * short-lived sign-in URL for the business owner's account; the resulting
 * session carries Clerk's `act` claim, which the dashboard renders as a
 * visible support banner. We deliberately do NOT build a homemade orgId
 * override: every tenant action resolves the org from auth() directly, so the
 * only safe impersonation is a real (marked) Clerk session.
 *
 * Constraints: mandatory reason, 30-minute expiry, full audit under the
 * target org.
 */

const IMPERSONATION_TTL_SECONDS = 30 * 60;

export type ImpersonationGrant = {
  url: string;
  expiresInMinutes: number;
  targetUserId: string;
};

export async function startImpersonation(
  orgId: string,
  reason: string,
): Promise<ActionResult<ImpersonationGrant>> {
  const operator = await requirePlatformOperator();

  const cleanReason = reason.trim();
  if (cleanReason.length < 10) {
    return {
      ok: false,
      error: 'Explicá el motivo del acceso (mínimo 10 caracteres)',
    };
  }

  // Impersonate the org owner (its Clerk admin member).
  const client = await clerkClient();
  const memberships
    = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 20,
    });
  const admin = memberships.data.find(m => m.role === 'org:admin');
  const targetUserId = admin?.publicUserData?.userId;
  if (!targetUserId) {
    return {
      ok: false,
      error: 'No se encontró el dueño (admin) de este negocio en Clerk',
    };
  }
  if (targetUserId === operator.userId) {
    return {
      ok: false,
      error: 'Sos el dueño de este negocio: entrá directo al dashboard',
    };
  }

  // The Backend SDK has no actor-token helper; call the Clerk API directly.
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return { ok: false, error: 'CLERK_SECRET_KEY no está configurada' };
  }

  const response = await fetch('https://api.clerk.com/v1/actor_tokens', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: targetUserId,
      actor: { sub: operator.userId },
      expires_in_seconds: IMPERSONATION_TTL_SECONDS,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      ok: false,
      error: `Clerk rechazó el token de soporte (${response.status}): ${detail.slice(0, 120)}`,
    };
  }

  const tokenPayload = (await response.json()) as {
    token?: string;
    url?: string | null;
  };
  if (!tokenPayload.token) {
    return { ok: false, error: 'Clerk no devolvió un token de soporte' };
  }

  const url
    = tokenPayload.url
      ?? `/sign-in?__clerk_ticket=${encodeURIComponent(tokenPayload.token)}`;

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: operator.userId },
    action: 'platform.org.impersonation_started',
    entityType: 'clerk_user',
    entityId: targetUserId,
    after: {
      reason: cleanReason,
      expiresInSeconds: IMPERSONATION_TTL_SECONDS,
    },
  });

  return {
    ok: true,
    data: {
      url,
      expiresInMinutes: IMPERSONATION_TTL_SECONDS / 60,
      targetUserId,
    },
  };
}
