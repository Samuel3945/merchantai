import { auth, clerkClient } from '@clerk/nextjs/server';
import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

export async function POST(request: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (!orgId) {
    return NextResponse.json({ error: 'No active organization' }, { status: 400 });
  }
  if (orgRole && orgRole !== 'org:admin') {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  }
  if (!Env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: 'BLOB_READ_WRITE_TOKEN is not configured' },
      { status: 500 },
    );
  }

  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'File exceeds 2MB limit' },
      { status: 413 },
    );
  }

  const ext = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.'))
    : '';
  const pathname = `logos/${orgId}/${Date.now()}${ext}`;

  const blob = await put(pathname, file, {
    access: 'public',
    contentType: file.type,
    token: Env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: true,
  });

  // The business logo IS the organization logo: push it to Clerk so the org
  // switcher and panel avatar match. Best-effort — a Clerk failure must not
  // break the upload the settings page depends on.
  try {
    const client = await clerkClient();
    await client.organizations.updateOrganizationLogo(orgId, {
      file,
      uploaderUserId: userId,
    });
  } catch (err) {
    logger.error('business_logo_org_sync_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ url: blob.url, pathname: blob.pathname });
}
