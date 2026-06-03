'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';
import { routing } from '@/libs/I18nRouting';
import {
  isStaleServerActionError,
  reloadForStaleServerAction,
} from '@/utils/staleServerAction';

export default function GlobalError(props: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    // A stale bundle after a deploy can surface here when a Server Action
    // bubbles to the boundary. Reload to recover before reporting noise.
    if (isStaleServerActionError(props.error) && reloadForStaleServerAction()) {
      return;
    }
    Sentry.captureException(props.error);
  }, [props.error]);

  return (
    <html lang={routing.defaultLocale}>
      <body>
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
