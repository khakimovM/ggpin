'use client';

import type { CatalogSku } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { MONEY_PLACEHOLDER, useFormatMoney } from '../../lib/format/money';

export interface SkuGridProps {
  skus: readonly CatalogSku[];
  selected: string | null;
  onSelect: (skuId: string) => void;
  /** Accessible name of the group. */
  ariaLabel: string;
  /** `grid`: two tiles per row (packages). `list`: one wide row each (Premium terms). */
  layout: 'grid' | 'list';
}

/**
 * Ready packages (Product.dc.html `isSkus` / `isPlans`) as one radio group: one tab stop, arrow
 * keys move and select. The price on a tile is the catalog's display price (`fromPriceTiyin`),
 * laid out as the server sent it; the price the visitor pays comes only from the quote.
 */
export function SkuGrid({ skus, selected, onSelect, ariaLabel, layout }: SkuGridProps) {
  const formatMoney = useFormatMoney();
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const focusable = skus.some((sku) => sku.id === selected) ? selected : (skus[0]?.id ?? null);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0 || skus.length === 0) return;
    event.preventDefault();
    const target = skus[(index + step + skus.length) % skus.length];
    if (target === undefined) return;
    onSelect(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={
        layout === 'grid' ? 'grid grid-cols-2 gap-2.5 pt-1.5' : 'flex flex-col gap-2.5 pt-1.5'
      }
    >
      {skus.map((sku, index) => {
        const on = sku.id === selected;
        const price = sku.fromPriceTiyin === null ? null : formatMoney(sku.fromPriceTiyin);
        return (
          <button
            key={sku.id}
            ref={(node) => {
              if (node) refs.current.set(sku.id, node);
              else refs.current.delete(sku.id);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={sku.id === focusable ? 0 : -1}
            onClick={() => onSelect(sku.id)}
            onKeyDown={(event) => move(event, index)}
            className={[
              // Motion table "SKU selection": press scale .97 (dur-instant), border and tint 140 ms, and no
              // scale under reduced motion (OS setting or the profile switch).
              'relative flex text-left transition duration-fast ease-standard active:scale-[.97] active:duration-instant motion-reduce:active:scale-100 [[data-reduced=true]_&]:active:scale-100',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              'border-[1.5px] text-foreground',
              on ? 'border-primary bg-primary-soft' : 'border-border bg-card',
              layout === 'grid'
                ? 'min-h-[74px] flex-col gap-1 rounded-2xl px-3.5 py-3'
                : 'min-h-[68px] items-center gap-3 rounded-[18px] px-3.5 py-3',
            ].join(' ')}
          >
            {layout === 'grid' ? (
              <span
                aria-hidden="true"
                className={`absolute top-2.5 right-2.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground transition-transform duration-slow ease-spring ${on ? 'scale-100' : 'scale-0'}`}
              >
                <Icon icon={Check} size={12} />
              </span>
            ) : (
              <span
                aria-hidden="true"
                className={`size-[22px] shrink-0 rounded-full bg-card ${on ? 'border-[7px] border-primary' : 'border-2 border-input-border'}`}
              />
            )}
            <span
              className={`text-base leading-[21px] font-extrabold tabular-nums ${layout === 'grid' ? 'pr-6' : 'min-w-0 flex-1'}`}
            >
              {sku.label}
            </span>
            {price !== null && price !== MONEY_PLACEHOLDER ? (
              <span
                className={`text-[13px] leading-[18px] font-bold tabular-nums ${layout === 'grid' ? 'text-foreground-secondary' : 'text-[15px] whitespace-nowrap'}`}
              >
                {price}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
