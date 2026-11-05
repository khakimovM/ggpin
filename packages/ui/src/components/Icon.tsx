import type { LucideIcon, LucideProps } from 'lucide-react';

export interface IconProps extends Omit<LucideProps, 'ref' | 'size'> {
  /** A lucide icon component, e.g. `Check` from lucide-react. */
  icon: LucideIcon;
  /** Pixel size; the design uses 13-24. */
  size?: number;
  /** Accessible name. Without it the icon is decorative and hidden from assistive tech. */
  label?: string;
}

export function Icon({ icon: Glyph, size = 18, label, ...rest }: IconProps) {
  return label ? (
    <Glyph size={size} role="img" aria-label={label} {...rest} />
  ) : (
    <Glyph size={size} aria-hidden="true" focusable="false" {...rest} />
  );
}
