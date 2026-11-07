'use client';

import { Icon } from '@repo/ui';
import { ImageIcon } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';

// Only a path of OUR site is ever loaded: the contract gives `/images/...`-style paths, and an
// absolute URL from the data would be a host the CSP (img-src) and next/image do not allow.
const PROBE = 'https://site.invalid';

export function isLocalImagePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  try {
    return new URL(value, PROBE).origin === PROBE;
  } catch {
    return false;
  }
}

interface ProductImageProps {
  src: string;
  /** The product name: the picture's accessible name. */
  alt: string;
  sizes: string;
  className?: string;
  /**
   * The picture adds nothing to the text next to it (the name is printed there): empty alt, and
   * when there is no picture (or it fails) NOTHING is drawn, so whatever is behind it shows.
   */
  decorative?: boolean;
}

/**
 * The product picture, filling its (aspect-ratio) box. When there is no usable picture, or it
 * fails to load, the muted box with an image glyph shows instead (the design's empty slot).
 * SVGs are served as they are (the optimiser does not process them).
 */
export function ProductImage({
  src,
  alt,
  sizes,
  className,
  decorative = false,
}: ProductImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const usable = isLocalImagePath(src) && failedSrc !== src;
  if (!usable) {
    if (decorative) return null;
    return (
      <span
        role="img"
        aria-label={alt}
        className="absolute inset-0 grid place-items-center bg-muted text-foreground-muted"
      >
        <Icon icon={ImageIcon} size={28} />
      </span>
    );
  }
  return (
    <Image
      src={src}
      alt={decorative ? '' : alt}
      fill
      sizes={sizes}
      unoptimized={src.toLowerCase().split('?')[0]?.endsWith('.svg') ?? false}
      onError={() => setFailedSrc(src)}
      className={className ?? 'object-cover'}
    />
  );
}
