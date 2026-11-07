'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { callSdk, type TelegramWebApp } from './webapp';

export interface MainButtonOptions {
  /** Button label (already translated). */
  text: string;
  /** Not shown when false. */
  visible?: boolean;
  /** Shown but grey and inert when false. */
  enabled?: boolean;
  /** Shows the progress spinner; presses are ignored while it is on. */
  loading?: boolean;
  /**
   * The action. It MUST return a promise: further presses are ignored until it settles, whether it
   * resolves or rejects. (A synchronous action cannot be guarded against a double tap: two presses
   * can arrive before React has re-rendered the `loading` flag.)
   */
  onClick: () => Promise<unknown>;
  /** Receives a rejection of `onClick`; without it the error goes to the window `error` event. */
  onError?: (error: unknown) => void;
}

/** A failure nobody asked to handle: shown to error reporters, not swallowed, not a rejection. */
function reportUnhandled(error: unknown): void {
  if (typeof reportError === 'function') {
    reportError(error);
    return;
  }
  window.dispatchEvent(
    new ErrorEvent('error', { error, message: error instanceof Error ? error.message : 'error' }),
  );
}

/**
 * Drives Telegram's native MainButton ("Sotib olish", "To‘lash"). One handler is registered for
 * the lifetime of the screen and always calls the latest `onClick`, so re-renders never stack
 * handlers. A press does nothing while the button is loading or disabled, or while the previous
 * press is still running: a double tap on a purchase button must produce exactly one purchase.
 */
export function useMainButton(
  webApp: TelegramWebApp | null,
  { text, visible = true, enabled = true, loading = false, onClick, onError }: MainButtonOptions,
): void {
  const latest = useRef({ enabled, loading, onClick, onError });
  // Layout effect: the latest values are in place before the browser can deliver another press.
  useLayoutEffect(() => {
    latest.current = { enabled, loading, onClick, onError };
  });
  const running = useRef(false);

  useEffect(() => {
    if (!webApp) return;
    const button = webApp.MainButton;
    const press = () => {
      const { enabled: canPress, loading: busy, onClick: action, onError: onFail } = latest.current;
      if (running.current || busy || !canPress) return;
      running.current = true;
      const release = () => {
        running.current = false;
      };
      const fail = (error: unknown) => {
        release();
        if (onFail) onFail(error);
        else reportUnhandled(error);
      };
      let pending: Promise<unknown>;
      try {
        pending = action();
      } catch (error) {
        // Threw before returning a promise: the same as a rejection.
        fail(error);
        return;
      }
      void pending.then(release, fail);
    };
    button.onClick(press);
    return () => {
      button.offClick(press);
      callSdk(() => button.hideProgress());
      callSdk(() => button.hide());
    };
  }, [webApp]);

  useEffect(() => {
    if (!webApp) return;
    const button = webApp.MainButton;
    callSdk(() => button.setText(text));
    callSdk(() => (enabled ? button.enable() : button.disable()));
    // leaveActive = false: Telegram itself also stops delivering presses while progress shows.
    callSdk(() => (loading ? button.showProgress(false) : button.hideProgress()));
    callSdk(() => (visible ? button.show() : button.hide()));
  }, [webApp, text, visible, enabled, loading]);
}
