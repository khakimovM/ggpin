'use client';

import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Accordion as AccordionPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, REDUCED_FADE, useReducedMotion } from '../lib/motion';
import { FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface AccordionItem {
  value: string;
  question: ReactNode;
  answer: ReactNode;
}

export interface AccordionProps {
  items: readonly AccordionItem[];
  /** Open item; omit for uncontrolled. One item is open at a time and it can be closed again. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}

// FAQ list. Height animates with motion (the design token durations); reduced motion only fades.
export function Accordion({
  items,
  value,
  defaultValue = '',
  onValueChange,
  className,
}: AccordionProps) {
  const [inner, setInner] = useState(defaultValue);
  const open = value ?? inner;
  const reduced = useReducedMotion();

  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={open}
      onValueChange={(next) => {
        setInner(next);
        onValueChange?.(next);
      }}
      className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}
    >
      {items.map((item) => {
        const expanded = open === item.value;
        return (
          <AccordionPrimitive.Item
            key={item.value}
            value={item.value}
            className="border-b border-border last:border-b-0"
          >
            <AccordionPrimitive.Header className="m-0">
              <AccordionPrimitive.Trigger
                className={cn(
                  'flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm leading-5 font-bold',
                  'transition-colors duration-fast ease-standard hover:bg-muted',
                  FOCUS_RING,
                  'focus-visible:ring-inset focus-visible:ring-offset-0',
                )}
              >
                <span className="min-w-0">{item.question}</span>
                <Icon
                  icon={ChevronDown}
                  size={18}
                  className={cn(
                    'shrink-0 text-foreground-muted transition-transform duration-base ease-standard',
                    expanded && 'rotate-180',
                  )}
                />
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
            <AnimatePresence initial={false}>
              {expanded ? (
                <AccordionPrimitive.Content forceMount asChild>
                  <motion.div
                    initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                    exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={
                      reduced ? REDUCED_FADE : { duration: DURATION.base, ease: EASE.standard }
                    }
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 text-sm leading-[21px] font-medium text-foreground-secondary">
                      {item.answer}
                    </div>
                  </motion.div>
                </AccordionPrimitive.Content>
              ) : null}
            </AnimatePresence>
          </AccordionPrimitive.Item>
        );
      })}
    </AccordionPrimitive.Root>
  );
}
