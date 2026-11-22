import { FOCUS_RING, Icon, cn } from '@repo/ui';
import { ChevronDown } from 'lucide-react';
import { useId } from 'react';

interface Props {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

/**
 * The "Key: Value ⌄" dropdown filter of the design, built on a native select (keyboard, screen
 * readers and touch work as the platform does). The visible label stays outside the select.
 */
export function SelectFilter({ label, value, options, onChange }: Props) {
  const id = useId();
  return (
    <span
      className={cn(
        'relative inline-flex h-[34px] items-center gap-1 rounded-[9px] border-[1.5px] border-border bg-card pr-7 pl-3 text-xs leading-none font-bold',
        'focus-within:border-ring',
      )}
    >
      <label htmlFor={id} className="whitespace-nowrap text-foreground-muted">
        {label}:
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'absolute inset-0 cursor-pointer appearance-none rounded-[9px] bg-transparent pr-7 text-transparent',
          FOCUS_RING,
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="text-foreground">
            {option.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none whitespace-nowrap text-foreground">
        {options.find((option) => option.value === value)?.label}
      </span>
      <Icon
        icon={ChevronDown}
        size={14}
        className="pointer-events-none absolute right-2 text-foreground-muted"
      />
    </span>
  );
}
