import { consumeCredit } from '@/actions/plans';
import { Env } from '@/libs/Env';
import { resolveOrgOpenAiKey } from '@/libs/openai-key';

// Resolves AI access for the importers (products, suppliers, …) with BYOK
// precedence: the org's own OpenAI key bills their account (no credit spent);
// otherwise the platform key is used and one shared-pool credit is consumed.
// `null` means no usable key — callers should surface a "configure your key"
// notice instead of throwing, so the owner knows how to enable it.
export async function resolveAiAccess(
  orgId: string,
): Promise<{ apiKey: string; remaining: number } | null> {
  const byok = await resolveOrgOpenAiKey(orgId);
  const apiKey = byok ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (byok) {
    return { apiKey, remaining: Number.POSITIVE_INFINITY };
  }
  const credit = await consumeCredit();
  if (!credit.success) {
    return null;
  }
  return { apiKey, remaining: credit.remaining };
}
