'use client';

import { DURATION, EASE, useReducedMotion } from '@repo/ui';
import { formatMoney } from '@repo/shared';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useLocale } from 'next-intl';
import { useEffect } from 'react';
import { MONEY_PLACEHOLDER } from '../../lib/format/money';
import { formatTiyinString } from '../../lib/format/tiyin';

const TIYIN_STRING = /^-?(0|[1-9]\d{0,18})$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(tiyin: string): number | null {
  if (!TIYIN_STRING.test(tiyin)) return null;
  const value = BigInt(tiyin);
  return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : null;
}

/**
 * An amount that counts up (or down) to the server's new value when it changes. It only lays out
 * what the server sent: the animation is drawing, and the number it rests on is the server's
 * string, exactly. Under reduced motion the new value appears at once; an amount too large for
 * a double is shown as it is, without animation (it must not lose a digit on the way).
 *
 * This is the one place an amount goes through `Number`, and it is safe: only for |tiyin| <= 2^53
 * (checked by `toSafeNumber`), only as the intermediate steps of the drawing, and the value it
 * rests on is the same integer, so the text is exact. lib/format/tiyin.ts, which formats an amount
 * without `Number`, stays the rule for everything else.
 */
export function AnimatedMoney({ tiyin, className }: { tiyin: string; className?: string }) {
  const locale = useLocale();
  const reduced = useReducedMotion();
  const target = toSafeNumber(tiyin);
  const value = useMotionValue(target ?? 0);
  const text = useTransform(value, (current) => formatMoney(BigInt(Math.round(current)), locale));

  useEffect(() => {
    if (target === null) return;
    if (reduced) {
      value.set(target);
      return;
    }
    const controls = animate(value, target, { duration: DURATION.slower * 1.5, ease: EASE.out });
    return () => controls.stop();
  }, [target, reduced, value]);

  if (target === null) {
    return (
      <span className={className}>{formatTiyinString(tiyin, locale) ?? MONEY_PLACEHOLDER}</span>
    );
  }
  return <motion.span className={className}>{text}</motion.span>;
}
