import { cn } from '../lib/cn';

export interface LogoProps {
  /**
   * mark: square app icon; avatar: round (bot avatar); wordmark: the lowercase name.
   */
  variant?: 'mark' | 'avatar' | 'wordmark';
  /** Pixel size: the mark edge, or the wordmark font size. The design uses 16-512. */
  size?: number;
  /** Brand name, passed in by the caller (it lives in one place: packages/shared brand). */
  name: string;
  /**
   * Hide the logo from assistive tech and from the "visible text" of its parent. Use it for a mark
   * inside a link that carries its own name (WCAG 2.5.3: the name must contain what is shown).
   */
  decorative?: boolean;
  className?: string;
}

// Mark proportions from the design: 96px -> radius 28, glyph 44, right padding 6; 48px -> 14/22/3;
// 32px -> 9/15/2. Up to 20px a single accent "g" is used.
export function Logo({ variant = 'mark', size = 48, name, decorative, className }: LogoProps) {
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': name } as const);
  if (variant === 'wordmark') {
    return (
      <span
        {...a11y}
        className={cn(
          'inline-block font-display font-bold leading-none text-foreground',
          className,
        )}
        style={{ fontSize: size, letterSpacing: size >= 48 ? '-.045em' : '-.04em' }}
      >
        <span aria-hidden="true">
          <span className="text-primary">{name.slice(0, 2)}</span>
          {name.slice(2)}
        </span>
      </span>
    );
  }

  const first = name.charAt(0);
  const second = name.charAt(1) || first;
  const single = size <= 20;
  return (
    <span
      {...a11y}
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-primary font-display font-extrabold leading-none text-primary-foreground',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: variant === 'avatar' ? '50%' : single ? 5 : Math.round(size * 0.29),
        fontSize: single ? 11 : Math.round(size * 0.46),
        letterSpacing: single ? undefined : '-.14em',
        paddingRight: single ? 0 : Math.round(size * 0.0625),
        paddingBottom: single ? 2 : 0,
      }}
    >
      {decorative ? (
        // The glyph is drawn by pseudo-elements: a decorative mark must add no text to its parent
        // (axe's label-content-name-mismatch reads aria-hidden text and splits the two letters).
        <span
          aria-hidden="true"
          data-first={first}
          data-second={second}
          className={
            single
              ? 'text-accent after:content-[attr(data-second)]'
              : 'before:content-[attr(data-first)] after:text-accent after:content-[attr(data-second)]'
          }
        />
      ) : (
        <span aria-hidden="true" className={single ? 'text-accent' : undefined}>
          {single ? (
            second
          ) : (
            <>
              {first}
              <span className="text-accent">{second}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
