'use client';

import { useEffect } from 'react';
import { subscribeAuthEvents } from '../../lib/api/auth-broadcast';
import { applyRemoteAuthEvent } from '../../lib/api/auth-remote';

/**
 * Keeps this tab in step with sign-ins and sign-outs made in the browser's other tabs
 * (`BroadcastChannel('ggpin-auth')`, `storage` event as the fallback). Renders nothing.
 */
export function AuthSync() {
  useEffect(() => subscribeAuthEvents(applyRemoteAuthEvent), []);
  return null;
}
