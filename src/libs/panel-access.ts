import { clerkClient } from '@clerk/nextjs/server';

/**
 * Web panel provisioning for the SINGLE business user.
 *
 * The employee is ONE entity (a `pos_users` row). Clerk is used ONLY as the web
 * identity provider so that user can also sign into the dashboard with the same
 * email + password they set for the POS. There is no separate "panel user".
 *
 * Source-of-truth contract: the database (`pos_users`) owns permissions. The
 * Clerk org-membership `publicMetadata.modules` is a CACHED COPY kept in sync so
 * the middleware can authorize fast without a DB round-trip. Every permission
 * change must call {@link syncPanelModules} to keep both sides identical.
 */

const ORG_MEMBER_ROLE = 'org:member';

type ProvisionPanelInput = {
  email: string;
  password: string;
  name: string;
  organizationId: string;
  enabledModules: string[];
};

type ProvisionPanelResult
  = | { ok: true; clerkUserId: string }
    | { ok: false; error: string };

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

async function ensureMembership(
  client: ClerkClient,
  organizationId: string,
  userId: string,
): Promise<void> {
  try {
    await client.organizations.createOrganizationMembership({
      organizationId,
      userId,
      role: ORG_MEMBER_ROLE,
    });
  } catch (error) {
    // "Already a member" is fine and idempotent; anything else is a real error.
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (!message.includes('already') && !message.includes('exists')) {
      throw error;
    }
  }
}

/**
 * Mirrors the user's allowed modules into their Clerk org-membership metadata.
 * No-op-safe: callers pass it for any user, but it only matters once the user
 * has a linked Clerk identity (a membership in this org).
 */
export async function syncPanelModules(
  organizationId: string,
  clerkUserId: string,
  enabledModules: string[],
): Promise<void> {
  const client = await clerkClient();
  await client.organizations.updateOrganizationMembershipMetadata({
    organizationId,
    userId: clerkUserId,
    publicMetadata: { modules: enabledModules },
  });
}

/**
 * Creates (or reuses) the Clerk web identity for a single business user and adds
 * them to the org as a member, then mirrors their modules. Never throws — returns
 * a tagged result so the caller can keep the POS account working even if web
 * provisioning fails (e.g. Clerk password policy, transient API error).
 */
export async function provisionPanelUser(
  input: ProvisionPanelInput,
): Promise<ProvisionPanelResult> {
  try {
    const client = await clerkClient();
    const email = input.email.trim().toLowerCase();

    // Reuse an existing Clerk identity when the email already exists (e.g. the
    // person already belongs to another business); otherwise create one with the
    // same password they just set for the POS.
    const existing = await client.users.getUserList({ emailAddress: [email] });
    let clerkUserId: string;
    if (existing.data[0]) {
      clerkUserId = existing.data[0].id;
    } else {
      const created = await client.users.createUser({
        emailAddress: [email],
        password: input.password,
        firstName: input.name,
      });
      clerkUserId = created.id;
    }

    await ensureMembership(client, input.organizationId, clerkUserId);
    await syncPanelModules(
      input.organizationId,
      clerkUserId,
      input.enabledModules,
    );

    return { ok: true, clerkUserId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'provision_failed',
    };
  }
}
