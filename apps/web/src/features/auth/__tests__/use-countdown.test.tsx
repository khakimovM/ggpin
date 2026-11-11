import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountdown } from '../use-countdown';

interface CountdownProps {
  deadline: number | null;
  notBefore?: number;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('useCountdown', () => {
  it('counts down to the deadline and stops at zero', () => {
    const deadline = Date.now() + 3000;
    const { result } = renderHook(() => useCountdown(deadline));
    expect(result.current).toBe(3000);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBeLessThanOrEqual(2000);
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0);
  });

  it('is 0 without a deadline', () => {
    expect(renderHook(() => useCountdown(null)).result.current).toBe(0);
  });

  it('a deadline that is already past is not shown as ahead, even when the clock reading is old', () => {
    // Mounted without a deadline, so the clock is not ticking; ten minutes pass; then a deadline
    // arrives that is one second behind us. The old reading alone would make it 9 minutes ahead.
    const initialProps: CountdownProps = { deadline: null };
    const { result, rerender } = renderHook(
      ({ deadline, notBefore }: CountdownProps) => useCountdown(deadline, notBefore),
      { initialProps },
    );
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const arrived = Date.now();
    rerender({ deadline: arrived - 1000, notBefore: arrived });
    // The very first value after the change, before any timer ran:
    expect(result.current).toBe(0);
  });
});
