import { auth, clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { logger } from '@/libs/Logger';
import { publicUploadUrl, saveUpload } from '@/libs/uploads';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;
// MIME type → extension. Deriving the extension from the validated content type
// (not the original filename) avoids trusting attacker-controlled names.
const ALLOWED_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export async function POST(request: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (!orgId) {
    return NextResponse.json({ error: 'No active organization' }, { status: 400 });
  }
  if (orgRole !== 'org:admin') {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  const ext = ALLOWED_EXT[file.type];
  if (!ext) {
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

  // Timestamp + random suffix keeps filenames unique so a new logo never serves
  // a stale cached copy under the same URL.
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const pathname = `logos/${orgId}/${filename}`;

  try {
    await saveUpload(pathname, file);
  } catch (err) {
    logger.error('logo_upload_write_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error:
          'No se pudo guardar el archivo. Verificá que el volumen de uploads exista y tenga permisos de escritura.',
      },
      { status: 500 },
    );
  }

  const url = publicUploadUrl(pathname);

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

  return NextResponse.json({ url, pathname });
}
