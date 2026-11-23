import { cn } from '@repo/ui';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { parseAmountInput, type AmountRules } from './amount-input';

interface Props extends AmountRules {
  label: string;
  /** What the admin typed (kept as text; the tiyin string comes from `parseAmountInput`). */
  value: string;
  onChange: (value: string) => void;
  /** A line under the field while it is valid (what the amount is for). */
  hint?: string;
  /** Re-typed amount that differs from the first one (step-up `confirmAmountTiyin`). */
  mismatch?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * A so'm amount input (AdminOps.dc.html balance dialog: 44px, 18px extrabold, "so‘m" inside on the
 * right). The text is parsed by the shared money module only; problems show after the first blur.
 */
export function AmountField({
  label,
  value,
  onChange,
  hint,
  mismatch = false,
  disabled,
  autoFocus,
  ...rules
}: Props) {
  const t = useTranslations();
  const id = useId();
  const [touched, setTouched] = useState(false);
  const parsed = parseAmountInput(value, rules);
  const issue = parsed.ok ? (mismatch ? 'mismatch' : null) : parsed.issue;
  const showIssue = touched && issue !== null && issue !== 'empty';
  const message = showIssue ? t(`admin.dialogs.amount.${issue}`) : (hint ?? null);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs leading-4 font-extrabold">
        {label}
      </label>
      <div className="relative flex">
        <input
          id={id}
          value={value}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={showIssue}
          aria-describedby={message === null ? undefined : `${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setTouched(true)}
          className={cn(
            'h-11 min-w-0 flex-1 rounded-[10px] border-[1.5px] bg-input pr-[50px] pl-3 text-lg leading-none font-extrabold text-foreground tabular-nums',
            'focus:border-ring focus:ring-[3px] focus:ring-primary-soft focus:outline-none disabled:opacity-55',
            showIssue ? 'border-danger' : 'border-input-border',
          )}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-3 bottom-0 flex items-center text-[13px] leading-none font-bold text-foreground-muted"
        >
          {t('admin.dialogs.amount.som')}
        </span>
      </div>
      {message === null ? null : (
        <span
          id={`${id}-hint`}
          className={cn(
            'text-[11px] leading-[15px] font-semibold',
            showIssue ? 'text-danger-text' : 'text-foreground-muted',
          )}
        >
          {message}
        </span>
      )}
    </div>
  );
}
