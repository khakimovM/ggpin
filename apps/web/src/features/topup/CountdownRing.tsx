import { TOPUP_DEFAULTS } from '@repo/shared';

const TOTAL_MS = TOPUP_DEFAULTS.INTENT_TTL_SEC * 1000;
const RADIUS = 24;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The thin progress ring of the waiting card (TopupMini.dc.html): what is left of the 30 minutes. */
export function CountdownRing({ msLeft, low }: { msLeft: number; low: boolean }) {
  const share = Math.min(1, Math.max(0, msLeft / TOTAL_MS));
  return (
    <svg aria-hidden="true" viewBox="0 0 56 56" className="size-14 shrink-0 -rotate-90">
      <circle cx="28" cy="28" r={RADIUS} fill="none" strokeWidth="4" className="stroke-muted" />
      <circle
        cx="28"
        cy="28"
        r={RADIUS}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - share)}
        className={`transition-[stroke-dashoffset] duration-[1000ms] ease-linear motion-reduce:transition-none ${
          low ? 'stroke-warning' : 'stroke-primary'
        }`}
      />
    </svg>
  );
}
