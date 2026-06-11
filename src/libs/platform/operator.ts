import { currentUser } from '@clerk/nextjs/server';

/**
 * Platform operator gate.
 *
 * The operator console (/platform) is the super-admin plane of MerchantAI:
 * it can read and mutate data across EVERY organization. Access is therefore
 * NOT tied to Clerk org membership — it is an explicit allowlist of platform
 * owners, resolved against the Clerk session user.
 *
 * Allowlist sources (checked in order):
 *   1. PLATFORM_OPERATOR_USER_IDS — comma-separated Clerk user ids (strongest).
 *   2. PLATFORM_OPERATOR_EMAILS  — comma-separated emails, matched only against
 *      VERIFIED addresses of the session user.
 *   3. Built-in owner email fallback, so the console works before the env vars
 *      exist on the VPS. Email verification is enforced by Clerk, so a stranger
 *      cannot claim the address.
 *
 * This module must only ever be imported from server code.
 */

const DEFAULT_OPERATOR_EMAILS = ['samuelalzatetejada@gmail.com'];

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function allowedUserIds(): Set<string> {
  // User ids are case-sensitive; do not lowercase them.
  return new Set(
    (process.env.PLATFORM_OPERATOR_USER_IDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

function allowedEmails(): Set<string> {
  const fromEnv = parseCsvEnv(process.env.PLATFORM_OPERATOR_EMAILS);
  return new Set(fromEnv.length > 0 ? fromEnv : DEFAULT_OPERATOR_EMAILS);
}

export type PlatformOperator = {
  userId: string;
  email: string | null;
};

/**
 * Resolves the current session user as a platform operator, or null when the
 * user is anonymous or not on the allowlist. Never throws for normal denials.
 */
export async function getPlatformOperator(): Promise<PlatformOperator | null> {
  const user = await currentUser();
  if (!user) {
    return null;
  }

  const primaryEmail
    = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId)
      ?.emailAddress ?? null;

  if (allowedUserIds().has(user.id)) {
    return { userId: user.id, email: primaryEmail };
  }

  const verifiedEmails = user.emailAddresses
    .filter(e => e.verification?.status === 'verified')
    .map(e => e.emailAddress.toLowerCase());

  const allowed = allowedEmails();
  if (verifiedEmails.some(email => allowed.has(email))) {
    return { userId: user.id, email: primaryEmail };
  }

  return null;
}

/**
 * Hard gate for operator-only code paths (data access, server actions).
 * Throws on denial so a missing UI guard can never silently leak data.
 */
export async function requirePlatformOperator(): Promise<PlatformOperator> {
  const operator = await getPlatformOperator();
  if (!operator) {
    throw new Error('platform_operator_required');
  }
  return operator;
}
