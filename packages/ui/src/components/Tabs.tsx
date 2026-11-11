'use client';

import { motion } from 'motion/react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE } from '../lib/motion';
import { FOCUS_RING } from '../lib/styles';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Panel content. Omit when the tabs only drive a filter and the list lives outside. */
  content?: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the tab list. */
  ariaLabel: string;
  className?: string;
}

// Underline tabs for categories. The list scrolls horizontally instead of wrapping.
export function Tabs({ items, value, onValueChange, ariaLabel, className }: TabsProps) {
  const barId = useId();
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      <TabsPrimitive.List
        aria-label={ariaLabel}
        className="flex gap-5 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <TabsPrimitive.Trigger
              key={item.value}
              value={item.value}
              className={cn(
                'relative h-11 shrink-0 rounded-xs px-0.5 text-[15px] font-bold whitespace-nowrap',
                'transition-colors duration-fast ease-standard',
                selected
                  ? 'text-foreground'
                  : 'text-foreground-muted hover:text-foreground-secondary',
                FOCUS_RING,
              )}
            >
              {item.label}
              {selected ? (
                <motion.span
                  layoutId={barId}
                  aria-hidden="true"
                  transition={{ duration: DURATION.base, ease: EASE.standard }}
                  className="absolute inset-x-0 -bottom-px h-[3px] rounded-t-[3px] bg-primary"
                />
              ) : null}
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
      {/* Every tab gets a panel, even an empty one: Radix points aria-controls at it, and a
          dangling reference is an accessibility error. */}
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className={cn('focus-visible:outline-none', item.content !== undefined && 'pt-4')}
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
