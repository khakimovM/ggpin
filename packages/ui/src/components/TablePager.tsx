import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface TablePagerProps {
  /** "Jami 18 420 tadan 1–10", already formatted. */
  summary: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  className?: string;
}

const STEP = cn(
  'grid size-[30px] place-items-center rounded-badge border-[1.5px] border-border bg-transparent text-foreground',
  'disabled:cursor-not-allowed disabled:text-foreground-muted',
  FOCUS_RING,
);

/** The table footer of the admin lists: count summary on the left, previous / next on the right. */
export function TablePager({
  summary,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
  className,
}: TablePagerProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs leading-4 font-semibold text-foreground-muted tabular-nums',
        className,
      )}
    >
      <span>{summary}</span>
      <span className="flex gap-1">
        <button
          type="button"
          aria-label={previousLabel}
          disabled={!hasPrevious}
          onClick={onPrevious}
          className={STEP}
        >
          <Icon icon={ChevronLeft} size={15} />
        </button>
        <button
          type="button"
          aria-label={nextLabel}
          disabled={!hasNext}
          onClick={onNext}
          className={STEP}
        >
          <Icon icon={ChevronRight} size={15} />
        </button>
      </span>
    </div>
  );
}
