import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { logger } from '@/libs/Logger';
import { requirePanelModule } from '@/libs/panel-session';
import { publicUploadUrl, saveUpload } from '@/libs/uploads';
import { deliveryOrdersSchema } from '@/models/Schema';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;
// MIME type → extension. Deriving the extension from the validated content type
// (not the original filename) avoids trusting attacker-controlled names. No SVG
// here (unlike the logo upload) — this is a camera/gallery photo, never a vector.
const ALLOWED_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // A courier passes this gate too (unlike the logo upload's admin-only gate) —
  // they are the one taking the hand-off photo. requirePanelModule('delivery')
  // is the same server-side check every other delivery action uses: the org
  // admin always passes, a linked courier passes only when their pos_users row
  // has the 'delivery' module enabled.
  let orgId: string;
  try {
    ({ orgId } = await requirePanelModule('delivery'));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Forbidden';
    const status
      = message === 'Not authenticated'
        ? 401
        : message === 'No active organization'
          ? 400
          : 403;
    return NextResponse.json({ error: message }, { status });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const deliveryOrderId = formData.get('deliveryOrderId');

  if (typeof deliveryOrderId !== 'string' || !UUID_RE.test(deliveryOrderId)) {
    return NextResponse.json(
      { error: 'deliveryOrderId is required' },
      { status: 400 },
    );
  }
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

  // The order must actually belong to this org — requirePanelModule only scopes
  // to the org (a courier is not restricted to their OWN deliveries elsewhere
  // either), but this stops a validated-but-foreign id from being used as a
  // storage path segment for an order outside the caller's organization.
  const [order] = await db
    .select({ id: deliveryOrdersSchema.id })
    .from(deliveryOrdersSchema)
    .where(
      and(
        eq(deliveryOrdersSchema.id, deliveryOrderId),
        eq(deliveryOrdersSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!order) {
    return NextResponse.json(
      { error: 'Delivery order not found' },
      { status: 404 },
    );
  }

  // Timestamp + random suffix keeps filenames unique, same as the logo upload.
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const pathname = `deliveries/${orgId}/${deliveryOrderId}/${filename}`;

  try {
    await saveUpload(pathname, file);
  } catch (err) {
    logger.error('delivery_photo_upload_write_failed', {
      organizationId: orgId,
      deliveryOrderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error:
          'No se pudo guardar la foto. Verificá que el volumen de uploads exista y tenga permisos de escritura.',
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: publicUploadUrl(pathname) });
}
