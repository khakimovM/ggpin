import { User } from 'lucide-react';
import { Avatar as AvatarPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Icon } from './Icon';

export interface AvatarProps {
  /** Display name: used for the initials fallback and the accessible name. */
  name?: string;
  /** Telegram photo_url or an uploaded picture. */
  src?: string;
  size?: 24 | 32 | 40 | 44 | 48 | 56;
  /** Small marker in the bottom-right corner (the accent "g" of the design). */
  badge?: ReactNode;
  className?: string;
}

const TEXT_SIZE: Record<number, string> = {
  24: 'text-[9px]',
  32: 'text-xs',
  40: 'text-sm',
  // The Mini App home's profile line (MiniApp.dc.html): 44 px with 15 px initials.
  44: 'text-[15px]',
  48: 'text-base',
  56: 'text-xl',
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function Avatar({ name, src, size = 40, badge, className }: AvatarProps) {
  const initials = name ? initialsOf(name) : '';
  return (
    <span
      // One image with the person's name; the initials or the photo inside are its picture.
      // Without a name the avatar is decoration.
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <AvatarPrimitive.Root
        className={cn(
          'inline-grid size-full place-items-center overflow-hidden rounded-full bg-primary-soft font-extrabold text-primary-soft-foreground',
          TEXT_SIZE[size],
        )}
      >
        {src ? <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" /> : null}
        <AvatarPrimitive.Fallback>
          {initials ? (
            <span aria-hidden="true">{initials}</span>
          ) : (
            <Icon icon={User} size={Math.round(size * 0.4)} />
          )}
        </AvatarPrimitive.Fallback>
      </AvatarPrimitive.Root>
      {badge}
    </span>
  );
}
