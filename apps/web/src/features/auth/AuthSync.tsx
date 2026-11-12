'use client';

import { useEffect } from 'react';
import { subscribeAuthEvents } from '../../lib/api/auth-broadcast';

/**
 * Keeps this tab in step with sign-ins and sign-outs made in the browser's other tabs
 * (`BroadcastChannel('ggpin-auth')`, `storage` event as the fallback). Renders nothing. Lives in the
 * root locale layout, so a landing tab hears it too; the handler itself is loaded lazily.
 */
export function AuthSync() {
  useEffect(
    () =>
      subscribeAuthEvents((type) => {
        // Loaded on the first event, not with the page: auth-remote pulls in the API client and the
        // query client, which a landing visit that never hears from another tab must not pay for.
        import('../../lib/api/auth-remote').then(
          (remote) => remote.applyRemoteAuthEvent(type),
          () => {
            // The chunk could not be fetched (offline): this tab catches up on its next request.
          },
        );
      }),
    [],
  );
  return null;
}
