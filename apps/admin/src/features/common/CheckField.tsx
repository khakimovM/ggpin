import { cn } from '@repo/ui';
import { useId } from 'react';

interface Props {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** warning: a flag that overrides a safety check (override, emergency, security pause). */
  tone?: 'plain' | 'warning';
}

/** A labelled checkbox of an action dialog: a deliberate confirmation the body carries. */
export function CheckField({ label, checked, onChange, disabled, tone = 'plain' }: Props) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-h-11 items-start gap-2 rounded-sm px-3 py-2.5 text-xs leading-4 font-bold',
        tone === 'warning' ? 'bg-warning-soft text-warning-text' : 'bg-surface',
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-px size-4 flex-none accent-primary"
      />
      {label}
    </label>
  );
}
