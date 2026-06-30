/**
 * Agent API authentication.
 *
 * Two auth modes, evaluated in order:
 *
 * 1. SERVICE-SECRET PATH (if N8N_SERVICE_SECRET is set and Bearer matches):
 *    - Extract `X-Agent-Channel` header (the channel `instance_name`).
 *    - Look up `whatsapp_channels` by instanceName. Missing → 401.
 *    - Return AgentAuthContext with tokenId: null and capabilities from channel.
 *    - An empty or undefined N8N_SERVICE_SECRET NEVER matches any Bearer value
 *      (prevents empty-bearer == empty-secret bypass).
 *
 * 2. TOKEN PATH (existing; runs when service path doesn't match):
 *    - Extract UUID Bearer → resolve agent_tokens (org unknown until token row
 *      resolves) → check active + expiry → resolve whatsapp_channels.
 *    - Flow mirrors pos-auth.ts:188.
 *
 * agent-auth.ts lives in src/libs/ (outside the src/app/api guard scan), so
 * using raw @/libs/DB here is correct — exactly like pos-auth.ts:50.
 * All /api/agent/* routes MUST use db.forOrg() from db-context (never raw DB),
 * keeping them off RAW_DB_ALLOWLIST.
 */
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { db as tenantDb } from '@/libs/db-context';
import { Env } from '@/libs/Env';
import { agentTokensSchema, whatsappChannelsSchema } from '@/models/Schema';

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentAuthContext = {
  organizationId: string;
  channelId: string;
  capabilities: Record<string, boolean>;
  /** null when authenticated via service-secret path (no token row). */
  tokenId: string | null;
};

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(authHeader);
  return match?.[1]?.trim() || null;
}

function unauthorized(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Drop-in helper for agent route handlers.
 *
 * Returns `{ ctx, errorResponse: null }` on success, or
 * `{ ctx: null, errorResponse: NextResponse }` on any failure so the caller can
 * do: `const { ctx, errorResponse } = await requireAgentAuth(req); if (errorResponse) return errorResponse;`
 *
 * Org and channel values in the request body MUST be ignored — the token row is
 * the exclusive source of identity (spec §Token Resolution).
 */
export async function requireAgentAuth(
  req: Request,
): Promise<
  | { ctx: AgentAuthContext; errorResponse: null }
  | { ctx: null; errorResponse: NextResponse }
> {
  const bearer = extractBearer(req.headers.get('authorization'));
  if (!bearer) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  // ── Service-secret path ──────────────────────────────────────────────────
  // Guard: only active when N8N_SERVICE_SECRET is a non-empty string AND the
  // Bearer matches exactly. An empty/undefined secret NEVER matches.
  const serviceSecret = Env.N8N_SERVICE_SECRET;
  if (serviceSecret && bearer === serviceSecret) {
    const instanceName = req.headers.get('x-agent-channel')?.trim() ?? '';
    if (!instanceName) {
      return { ctx: null, errorResponse: unauthorized() };
    }

    const [channelRow] = await db
      .select()
      .from(whatsappChannelsSchema)
      .where(eq(whatsappChannelsSchema.instanceName, instanceName))
      .limit(1);

    if (!channelRow) {
      return { ctx: null, errorResponse: unauthorized() };
    }

    return {
      ctx: {
        organizationId: channelRow.organizationId,
        channelId: channelRow.id,
        capabilities: channelRow.capabilities ?? {},
        tokenId: null,
      },
      errorResponse: null,
    };
  }

  // ── Token path ───────────────────────────────────────────────────────────
  if (!UUID_RE.test(bearer)) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  // Step 1-2: resolve token using raw DB (org not yet known).
  const [tokenRow] = await db
    .select()
    .from(agentTokensSchema)
    .where(
      and(
        eq(agentTokensSchema.token, bearer),
        eq(agentTokensSchema.active, true),
      ),
    )
    .limit(1);

  if (!tokenRow) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  // Step 3: check expiry.
  if (tokenRow.expiresAt && tokenRow.expiresAt.getTime() < Date.now()) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  // Step 4: null channelId means the channel was deleted → invalid.
  if (!tokenRow.channelId) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  // Step 5: resolve channel + capabilities using scoped tenant db.
  const [channelRow] = await tenantDb
    .forOrg(tokenRow.organizationId)
    .select()
    .from(whatsappChannelsSchema)
    .where(eq(whatsappChannelsSchema.id, tokenRow.channelId))
    .limit(1);

  if (!channelRow) {
    return { ctx: null, errorResponse: unauthorized() };
  }

  return {
    ctx: {
      organizationId: tokenRow.organizationId,
      channelId: tokenRow.channelId,
      capabilities: channelRow.capabilities ?? {},
      tokenId: tokenRow.id,
    },
    errorResponse: null,
  };
}
