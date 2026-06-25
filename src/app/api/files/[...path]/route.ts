import path from 'node:path';
import { NextResponse } from 'next/server';
import { readUpload } from '@/libs/uploads';

export const runtime = 'nodejs';

// Only image types we accept on upload are served back. The extension also makes
// the URL contain a dot, which keeps it out of the proxy matcher (public access).
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const relativePath = segments.join('/');

  const contentType = CONTENT_TYPES[path.extname(relativePath).toLowerCase()];
  if (!contentType) {
    return NextResponse.json(
      { error: 'Unsupported file type' },
      { status: 415 },
    );
  }

  try {
    const buffer = await readUpload(relativePath);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        // Filenames carry a timestamp + random suffix, so content is immutable.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
