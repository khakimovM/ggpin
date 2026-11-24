import { PANEL_ASSIGNABLE_ROLES, type PanelAssignableRole } from '@repo/shared';
import { Icon, cn } from '@repo/ui';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';

// The fields of the admin dialogs (AdminOps.dc.html `addAdmin`: 40px, 10px radius, input colours,
// the Telegram ID in monospace). The add frame has placeholders only; the label is still there for
// screen readers, and `showLabel` makes it visible where a field starts filled (the change dialog).

const BOX =
  'h-10 w-full min-w-0 rounded-[10px] border-[1.5px] bg-input px-3 text-[13px] leading-none font-bold text-foreground focus:border-ring focus:ring-[3px] focus:ring-primary-soft focus:outline-none disabled:opacity-55';
const LABEL = 'text-[11px] leading-[14px] font-extrabold text-foreground-secondary';

interface TextProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Whether the value is acceptable; the error shows only after the field was left (S8b). */
  valid: boolean;
  error: string;
  showLabel?: boolean;
  disabled?: boolean;
  mono?: boolean;
}

export function AdminTextField({
  label,
  value,
  onChange,
  valid,
  error,
  showLabel = false,
  disabled,
  mono = false,
}: TextProps) {
  const id = useId();
  const [left, setLeft] = useState(false);
  const shown = left && !valid;
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <label htmlFor={id} className={showLabel ? LABEL : 'sr-only'}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={showLabel ? undefined : label}
        inputMode={mono ? 'numeric' : 'text'}
        autoComplete="off"
        spellCheck={!mono}
        disabled={disabled}
        aria-invalid={shown}
        aria-describedby={shown ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setLeft(true)}
        className={cn(
          BOX,
          shown ? 'border-danger' : 'border-input-border',
          mono ? 'font-mono tabular-nums' : undefined,
        )}
      />
      {shown ? (
        <span
          id={`${id}-error`}
          className="text-[11px] leading-[15px] font-semibold text-danger-text"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface RoleProps {
  label: string;
  value: PanelAssignableRole;
  onChange: (role: PanelAssignableRole) => void;
  showLabel?: boolean;
  disabled?: boolean;
}

/** OPERATOR or SUPPORT only: an OWNER is made with the CLI (D-63 (6)). A native select. */
export function AdminRoleField({ label, value, onChange, showLabel = false, disabled }: RoleProps) {
  const t = useTranslations();
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <label htmlFor={id} className={showLabel ? LABEL : 'sr-only'}>
        {label}
      </label>
      <span className="relative flex">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const next = PANEL_ASSIGNABLE_ROLES.find((role) => role === event.target.value);
            if (next !== undefined) onChange(next);
          }}
          className={cn(BOX, 'cursor-pointer appearance-none border-input-border pr-8')}
        >
          {PANEL_ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`admin.role.${role}`)}
            </option>
          ))}
        </select>
        <Icon
          icon={ChevronDown}
          size={13}
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-foreground"
        />
      </span>
    </div>
  );
}
