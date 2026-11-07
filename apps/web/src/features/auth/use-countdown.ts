'use client';

import { useEffect, useState } from 'react';

const TICK_MS = 500;

/**
 * Milliseconds left until `deadline` (epoch ms), re-read twice a second so a throttled background
 * tab never lags by more than a tick; 0 once it has passed or when there is no deadline. The
 * deadline is a timestamp, not a counter, so a sleeping laptop or a hidden tab catches up at once.
 */
export function useCountdown(deadline: number | null): number {
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
  return deadline === null ? 0 : Math.max(0, deadline - now);
}
