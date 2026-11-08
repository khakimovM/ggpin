'use client';

import { useEffect, useState } from 'react';

const TICK_MS = 500;

/**
 * Milliseconds left until `deadline` (epoch ms), re-read twice a second so a throttled background
 * tab never lags by more than a tick; 0 once it has passed or when there is no deadline. The
 * deadline is a timestamp, not a counter, so a sleeping laptop or a hidden tab catches up at once.
 *
 * The clock is re-read at once when the deadline changes (the effect's first tick), but that is
 * after the first render with the new deadline, which would still use the old reading. A caller
 * that knows a moment the deadline cannot predate (when its data arrived) passes it as
 * `notBefore`: the reading used is never older than that, so even the first render is right and a
 * deadline already past is never shown as still ahead. (The clock cannot be read during render:
 * the lint rule `react-hooks/purity` forbids it, and that is the right rule.)
 */
export function useCountdown(deadline: number | null, notBefore = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return undefined;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [deadline]);
  return deadline === null ? 0 : Math.max(0, deadline - Math.max(now, notBefore));
}
