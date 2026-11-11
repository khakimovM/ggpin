'use client';

import { SegmentedControl } from '@repo/ui';

export interface SkuTabsProps {
  /** Group labels in display order. */
  tabs: readonly string[];
  value: string;
  onValueChange: (tab: string) => void;
  ariaLabel: string;
}

// The catalog says `tab` is a group label (docs/04); it is shown as the server sent it, in the
// language of the request. No product uses tabs yet (Stars and Premium have none).
export function SkuTabs({ tabs, value, onValueChange, ariaLabel }: SkuTabsProps) {
  return (
    <SegmentedControl
      variant="neutral"
      ariaLabel={ariaLabel}
      value={value}
      onValueChange={onValueChange}
      options={tabs.map((tab) => ({ value: tab, label: tab }))}
    />
  );
}
