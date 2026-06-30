/**
 * Agent API authentication.
 *
 * Resolves AgentAuthContext from the Bearer token in the Authorization header.
 * Flow mirrors pos-auth.ts:188:
 *   1. Extract Bearer (UUID_RE).
 *   2. Raw-db select agent_tokens (org is unknown until the token row resolves).
 *   3. Check active=true and expiresAt not in the past.
 *   4. db.forOrg(organizationId) select whatsapp_channels for the channel.
 *   5. channelId null or channel missing → 401.
 *   6. Return ctx with capabilities from the channel row.
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
import { agentTokensSchema, whatsappChannelsSchema } from '@/models/Schema';

const UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentAuthContext = {
  organizationId: string;
  channelId: string;
  capabilities: Record<string, boolean>;
  tokenId: string;
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
  if (!bearer || !UUID_RE.test(bearer)) {
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
