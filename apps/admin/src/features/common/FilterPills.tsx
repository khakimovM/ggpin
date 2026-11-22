import { FOCUS_RING, cn } from '@repo/ui';

export interface PillOption {
  value: string;
  label: string;
  /** Muted count after the label. */
  count?: string;
}

interface Props {
  /** Accessible name of the group ("Holat"). */
  label: string;
  options: readonly PillOption[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * The segmented status filter of the admin lists (Admin.dc.html: muted track, 3px inset, the
 * selected pill on the card colour with a small shadow). Buttons with aria-pressed, in the tab order.
 */
export function FilterPills({ label, options, value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] bg-muted p-[3px]"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-7 flex-none items-center gap-1.5 rounded-[7px] px-3 text-xs leading-none font-bold whitespace-nowrap',
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'text-foreground-secondary hover:text-foreground',
              FOCUS_RING,
            )}
          >
            {option.label}
            {option.count ? (
              <span className="font-semibold text-foreground-muted tabular-nums">
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
