import { LoaderCircle } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SpinnerProps {
  size?: number;
  className?: string;
}

// gg-spin lives in tokens.css; under reduced motion the animation is switched off there and the
// icon stays static.
export function Spinner({ size = 18, className }: SpinnerProps) {
  return (
    <LoaderCircle
      size={size}
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0 animate-[gg-spin_900ms_linear_infinite]', className)}
    />
  );
}
