import { NextResponse } from 'next/server';
import { getAppSetting } from '@/actions/app-settings';

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  try {
    const setting = await getAppSetting(key);
    return NextResponse.json(setting);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'Not authenticated' || message === 'No active organization' ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
