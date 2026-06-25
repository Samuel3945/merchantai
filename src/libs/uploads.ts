import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Env } from '@/libs/Env';

/**
 * Root directory where user uploads (business logos, etc.) are persisted on
 * disk. In production this MUST point at a persistent volume (e.g. /data/uploads
 * mounted in EasyPanel) so files survive container redeploys — the runtime
 * container filesystem is recreated on every deploy. Falls back to a
 * project-local folder for local development.
 */
export function getUploadDir(): string {
  return Env.UPLOAD_DIR ?? path.join(process.cwd(), '.uploads');
}

/**
 * Resolve a caller-provided relative path to an absolute path INSIDE the upload
 * dir, rejecting anything that escapes it (path-traversal guard). Always pass
 * forward-slash separated relative paths (e.g. `logos/<orgId>/<file>.png`).
 */
export function resolveUploadPath(relativePath: string): string {
  const base = path.resolve(getUploadDir());
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Invalid upload path');
  }
  return target;
}

/** Persist a File to `relativePath` under the upload dir, creating dirs. */
export async function saveUpload(
  relativePath: string,
  file: File,
): Promise<void> {
  const target = resolveUploadPath(relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(target, buffer);
}

/** Read a stored upload as bytes (throws if missing or escaping the base). */
export async function readUpload(relativePath: string): Promise<Buffer> {
  const target = resolveUploadPath(relativePath);
  return readFile(target);
}

/**
 * Build the public URL the browser uses to fetch a stored upload. Absolute when
 * NEXT_PUBLIC_APP_URL is set (so the logo also resolves in emails, tickets and
 * invoices rendered outside the app origin); relative otherwise.
 */
export function publicUploadUrl(relativePath: string): string {
  const pathPart = `/api/files/${relativePath}`;
  return Env.NEXT_PUBLIC_APP_URL
    ? new URL(pathPart, Env.NEXT_PUBLIC_APP_URL).toString()
    : pathPart;
}
