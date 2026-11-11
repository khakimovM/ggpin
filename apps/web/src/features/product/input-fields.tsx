'use client';

import type { InputField } from '@repo/shared';
import { Input } from '@repo/ui';
import { useTranslations } from 'next-intl';
import type { KeyboardEvent, ReactNode } from 'react';

export interface RecipientInputProps {
  field: InputField;
  value: string;
  onValueChange: (value: string) => void;
  /** Pressing Enter in the field. */
  onSubmit: () => void;
  error?: ReactNode;
  disabled?: boolean;
}

/**
 * One field of the product's `inputSchema`, picked by its `type`. Only `tgUsername` exists today;
 * a product with any other type never reaches this component (`isSupported` in selection.ts shows
 * it as unavailable instead). The label is the catalog's `fields.*` key, mapped here per type so
 * the key stays a typed one.
 */
export function RecipientInput({
  field,
  value,
  onValueChange,
  onSubmit,
  error,
  disabled,
}: RecipientInputProps) {
  const t = useTranslations('fields');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  };
  switch (field.type) {
    case 'tgUsername':
      return (
        <Input
          kind="username"
          label={t('tgUsername')}
          value={value}
          onValueChange={onValueChange}
          onKeyDown={onKeyDown}
          error={error}
          disabled={disabled}
          maxLength={33}
          placeholder={t('tgUsernamePlaceholder')}
        />
      );
  }
}
