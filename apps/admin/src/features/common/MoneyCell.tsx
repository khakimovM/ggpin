import { cn } from '@repo/ui';
import { useTranslations } from 'use-intl';
import { formatSignedTiyin, formatTiyin } from '../../lib/format';

interface Props {
  /** Tiyin as the API sends it (a decimal string). */
  tiyin: string;
  /** Show "+" on credits and colour the sign (ledger rows). */
  signed?: boolean;
  /** Leave the "so‘m" word out (the column header already says it). */
  bare?: boolean;
  className?: string;
}

/** A so'm amount: formatMoney through formatTiyin, never arithmetic in the browser. */
export function MoneyCell({ tiyin, signed = false, bare = false, className }: Props) {
  const t = useTranslations();
  const negative = tiyin.startsWith('-');
  const text = signed ? formatSignedTiyin(tiyin) : formatTiyin(tiyin);
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        signed && (negative ? 'text-danger-text' : tiyin === '0' ? '' : 'text-success-text'),
        !signed && negative && 'text-danger-text',
        className,
      )}
    >
      {text}
      {bare ? null : ` ${t('admin.money.som')}`}
    </span>
  );
}
