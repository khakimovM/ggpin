import type { ReactNode } from 'react';

/** The filter row above a list: pills, dropdowns and search, wrapping on a tablet. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
