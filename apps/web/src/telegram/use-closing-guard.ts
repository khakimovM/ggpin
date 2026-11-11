'use client';

import { useEffect } from 'react';
import { callSdk, type TelegramWebApp } from './webapp';

/**
 * While `active` (a payment request is on its way) asks before the page or the Mini App is closed:
 * Telegram's own confirmation in the Mini App, the browser's `beforeunload` prompt on the web. An
 * optional protection: closing mid-request is survivable (the attempt is written down first and
 * checked again later), it just avoids the doubt in the common case.
 */
export function useClosingGuard(webApp: TelegramWebApp | null, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (webApp !== null) {
      callSdk(() => webApp.enableClosingConfirmation?.());
      return () => callSdk(() => webApp.disableClosingConfirmation?.());
    }
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers read the return value; modern ones ignore the text and show their own.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [webApp, active]);
}
