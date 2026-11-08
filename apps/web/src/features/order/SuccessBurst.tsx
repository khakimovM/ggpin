'use client';

import { Icon, useReducedMotion } from '@repo/ui';
import { PartyPopper } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

const COLORS = [
  'bg-primary',
  'bg-accent',
  'bg-success',
  'bg-info',
  'bg-danger',
  'bg-star',
] as const;
const PIECES = 18;

/**
 * Whether this order's burst has not been played in this tab yet; claims it. The flag is
 * `ggpin:burst:<orderId>` in sessionStorage: a reload of the delivered order does not throw
 * confetti again, and the flag holds no money or personal data. Storage can be blocked (private
 * mode): then the burst simply plays once per mount.
 */
export function claimBurst(orderId: string): boolean {
  const key = `ggpin:burst:${orderId}`;
  try {
    if (window.sessionStorage.getItem(key) !== null) return false;
    window.sessionStorage.setItem(key, '1');
  } catch {
    // blocked storage: play once anyway
  }
  return true;
}

/**
 * Confetti over the "Yetkazildi!" card, once per order (Checkout.dc.html `order: delivered`).
 * Pure decoration: hidden from assistive tech, no pointer events. Under reduced motion nothing
 * moves; a still party icon stays instead.
 */
export function SuccessBurst({ orderId }: { orderId: string }) {
  const reduced = useReducedMotion();
  const [play, setPlay] = useState(false);
  useEffect(() => {
    // After a tick: a StrictMode double run cleans the first timer, so the order is claimed once.
    const timer = setTimeout(() => {
      if (claimBurst(orderId)) setPlay(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [orderId]);

  if (reduced) {
    return (
      <span aria-hidden="true" className="pointer-events-none absolute top-3 right-3 text-accent">
        <Icon icon={PartyPopper} size={22} />
      </span>
    );
  }
  if (!play) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: PIECES }, (_, index) => {
        const angle = (index / PIECES) * Math.PI * 2;
        const distance = 90 + (index % 3) * 34;
        return (
          <motion.span
            key={index}
            className={`absolute top-[44%] left-1/2 h-2.5 w-1.5 rounded-[2px] ${COLORS[index % COLORS.length]}`}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
            animate={{
              x: Math.cos(angle) * distance,
              y: Math.sin(angle) * distance + 40,
              opacity: 0,
              rotate: 240 + index * 20,
              scale: 0.6,
            }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
          />
        );
      })}
    </span>
  );
}
