import type { ReactNode } from 'react';

/** The small uppercase heading over a block of a screen (Account.dc.html "Til", "Xizmatlar"...). */
export function SectionHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2
      id={id}
      className="m-0 px-1 text-[13px] leading-[18px] font-bold tracking-[.04em] text-foreground-muted uppercase"
    >
      {children}
    </h2>
  );
}
