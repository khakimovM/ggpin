import { FIELD_FOCUS, Icon, cn } from '@repo/ui';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Props {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}

/**
 * The search box of a list (design: 34px, 200-220 wide, magnifier inside). The URL changes 300 ms
 * after typing stops, so every key press is not a request; Enter applies at once.
 */
export function SearchField({ label, placeholder, value, onChange, maxLength = 64 }: Props) {
  const [draft, setDraft] = useState(value);
  // The URL changed from outside (Back, a cleared filter): show its value, during render. Our own
  // debounced write sends the trimmed draft; that echo must not eat a trailing space the admin is
  // still typing ("ali " before "valiyev", R-15).
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    if (value !== draft.trim()) setDraft(value);
  }
  useEffect(() => {
    if (draft.trim() === value) return undefined;
    const timer = setTimeout(() => onChange(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <span className="relative inline-flex w-full sm:w-[220px]">
      <Icon
        icon={Search}
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-muted"
      />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        maxLength={maxLength}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(draft.trim());
        }}
        className={cn(
          'h-[34px] w-full rounded-[9px] border-[1.5px] border-border bg-card pr-2.5 pl-8 text-xs font-semibold text-foreground placeholder:text-foreground-muted',
          FIELD_FOCUS,
        )}
      />
    </span>
  );
}
