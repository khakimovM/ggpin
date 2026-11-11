'use client';

import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name; a Switch has no visible label of its own. */
  label: string;
  /** md: 52x32 (profile); sm: 40x24 (admin dense tables). */
  size?: 'md' | 'sm';
  disabled?: boolean;
  id?: string;
}

// Thumb colour is primary-foreground (white in both themes), the design's plain white thumb.
export function Switch({
  checked,
  onCheckedChange,
  label,
  size = 'md',
  disabled,
  id,
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative flex shrink-0 items-center rounded-full transition-colors duration-fast ease-standard',
        HIT_AREA_44,
        'bg-input-border data-[state=checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-55',
        size === 'md' ? 'h-8 w-[52px]' : 'h-6 w-10',
        FOCUS_RING,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-primary-foreground shadow-sm',
          'transition-transform duration-base ease-spring',
          size === 'md'
            ? 'size-[26px] translate-x-[3px] data-[state=checked]:translate-x-[23px]'
            : 'size-[18px] translate-x-[3px] data-[state=checked]:translate-x-[19px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
