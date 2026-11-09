/** The pulsing "waiting" dot (the design's live status marker); still under reduced motion. */
export function WaitingDot() {
  return (
    <span aria-hidden="true" className="relative inline-block size-2.5 shrink-0">
      <span className="absolute inset-0 animate-[gg-pulse_1600ms_var(--ease-out)_infinite] rounded-full bg-info motion-reduce:hidden" />
      <span className="absolute inset-0 rounded-full bg-info" />
    </span>
  );
}
