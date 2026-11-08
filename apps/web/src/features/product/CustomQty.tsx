'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { Chip, Stepper } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useFormatMoney, MONEY_PLACEHOLDER } from '../../lib/format/money';
import { haptics } from '../../telegram/haptics';
import { checkQuantity } from './selection';

/** What the - and + buttons add: the design's step for the quantity field (Product.dc.html). */
export const QTY_STEP = 50;

export interface CustomQtyProps {
  product: CatalogProductDetail;
  value: string;
  onValueChange: (value: string) => void;
  min: number;
  max: number;
}

/**
 * Free quantity (Stars): a stepper, the catalog's packages as quick picks, and the range the
 * catalog allows. A value outside it is an error in the form and no quote is asked for. The
 * line under the field is the catalog's per-unit display price with "taxminan"; the total comes
 * from the quote and is never multiplied out here.
 */
export function CustomQty({ product, value, onValueChange, min, max }: CustomQtyProps) {
  const t = useTranslations('store.product.qty');
  const formatMoney = useFormatMoney();
  const valid = checkQuantity(value, min, max).ok;
  const unit = product.unitPriceTiyin === null ? null : formatMoney(product.unitPriceTiyin);
  const picks = product.skus.filter((sku) => sku.quantity >= min && sku.quantity <= max);

  return (
    <div className="flex flex-col gap-3">
      <Stepper
        label={t('label')}
        value={value}
        onValueChange={onValueChange}
        min={min}
        max={max}
        step={QTY_STEP}
        maxDigits={String(max).length}
        decrementLabel={t('decrement')}
        incrementLabel={t('increment')}
        adornment="⭐"
        error={valid ? undefined : t('range', { min, max })}
        help={
          unit !== null && unit !== MONEY_PLACEHOLDER ? t('unitPrice', { price: unit }) : undefined
        }
      />
      {picks.length > 0 ? (
        <div role="group" aria-label={t('presets')} className="grid grid-cols-3 gap-2">
          {picks.map((sku) => (
            <Chip
              key={sku.id}
              variant="quick"
              selected={value === String(sku.quantity)}
              onClick={() => {
                haptics.selection();
                onValueChange(String(sku.quantity));
              }}
            >
              {sku.label}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
