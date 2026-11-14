import { ANALYTICS_BEFORE_SEND, analyticsBeforeSend } from './analytics-before-send';

/**
 * The function the Umami tracker finds under `window[data-before-send]`. One per page load (module
 * scope), so a second marketing page in the same window recognises the filter it put there itself.
 */
export const ANALYTICS_FILTER = (type: unknown, payload: unknown): Record<string, string> | false =>
  analyticsBeforeSend(type, payload, window.location.origin);

/**
 * Puts the filter on `target` (the window) and says whether the tracker may be loaded.
 *
 * The tracker is fail-open: when `window[name]` is not a function it sends the beacon unfiltered.
 * So this is fail-closed: `true` only when the window's own property under the name is exactly our
 * filter. Anything else answering to the name (an injected `<img id>` or `<form name>` reached
 * through the window's named properties, a property on the prototype, an own value put there by
 * someone else) gives `false`, and the script tag is never rendered.
 *
 * The property is not writable and not configurable: nothing on the page can swap the filter for
 * one that lets more through. It is never taken off; it outlives the tracker's page.
 */
export function installAnalyticsFilter(target: object): boolean {
  if (Object.prototype.hasOwnProperty.call(target, ANALYTICS_BEFORE_SEND)) {
    return Reflect.get(target, ANALYTICS_BEFORE_SEND) === ANALYTICS_FILTER;
  }
  if (ANALYTICS_BEFORE_SEND in target) return false;
  try {
    Object.defineProperty(target, ANALYTICS_BEFORE_SEND, {
      value: ANALYTICS_FILTER,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    // A frozen or sealed window: no filter, so no tracker.
    return false;
  }
  const installed: unknown = Reflect.get(target, ANALYTICS_BEFORE_SEND);
  return typeof installed === 'function' && installed === ANALYTICS_FILTER;
}
