import { cn } from '@repo/ui';
import { Block } from '../landing/ProductsSkeleton';
import { LANDING_CTA_BOX } from '../landing/landing-styles';
import type { PlaceholderTexts } from './product-placeholder';
import {
  BUY_BUTTON_SIZE,
  FACT_CARD,
  FACT_GRID,
  FACT_LABEL,
  FACT_VALUE,
  PICKER_CARD,
  PICKER_HEAD,
  PICKER_NOTE,
  PICKER_ROW,
  PICKER_ROWS,
  PRODUCT_BUTTONS,
  TELEGRAM_BUTTON_SIZE,
} from './product-styles';

// Placeholders while the catalog is read (the <Suspense> fallbacks of the product page). Each one
// is built like the block it stands for, from the same sizes (product-styles.ts) and around the same
// texts, so it takes that block's room at every width and in both languages, and the page does not
// move when the answer arrives (layout shift). Plain CSS: the shimmer is hidden under reduced
// motion, leaving the static fill.

/**
 * Text that takes the room of the real one without being part of the page's text: CSS draws it
 * from `data-ghost`, invisibly, so it is never shown, read out or indexed.
 */
function Ghost({ text, className }: { text: string; className?: string }) {
  return (
    <span
      data-ghost={text}
      className={cn('invisible after:content-[attr(data-ghost)]', className)}
    />
  );
}

export function FactsSkeleton({ cards }: { cards: PlaceholderTexts['facts'] }) {
  return (
    <div aria-hidden="true" className={FACT_GRID}>
      {cards.map((card) => (
        <span key={card.kind} className={cn(FACT_CARD, 'relative')}>
          <Ghost text={card.label} className={FACT_LABEL} />
          <Ghost text={card.value} className={FACT_VALUE} />
          <span className="absolute inset-x-3.5 top-3.5 flex flex-col gap-2">
            <Block className="h-3 w-1/2 rounded-[4px]" />
            <Block className="h-4 w-3/4 rounded-[5px]" />
          </span>
        </span>
      ))}
    </div>
  );
}

export function BadgesSkeleton() {
  return (
    <span aria-hidden="true" className="flex min-h-6 gap-1.5">
      <Block className="h-6 w-16 rounded-badge" />
      <Block className="h-6 w-20 rounded-badge" />
    </span>
  );
}

/** The package list with its small print, then the buy and Telegram buttons (PackagePicker). */
export function BuyPanelSkeleton({ texts }: { texts: PlaceholderTexts }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-5">
      <span className="sr-only">{texts.loading}</span>
      <div aria-hidden="true" className={PICKER_CARD}>
        <span className={PICKER_HEAD}>
          <Block className="my-0.5 h-3 w-14 rounded-[4px]" />
          <Block className="my-0.5 h-3 w-10 rounded-[4px]" />
        </span>
        <span className={PICKER_ROWS}>
          {Array.from({ length: texts.rows }, (_, index) => (
            <span key={index} className={cn(PICKER_ROW, 'border-transparent')}>
              <Block className="size-5 rounded-full" />
              <Block className="h-4 w-20 rounded-[5px]" />
              <Block className="ml-auto h-4 w-24 rounded-[5px]" />
            </span>
          ))}
        </span>
        {texts.notes.map((note) => (
          <span key={note} className={cn(PICKER_NOTE, 'relative block')}>
            <Ghost text={note} />
            <Block className="absolute top-3 left-3.5 h-3 w-2/3 rounded-[4px]" />
          </span>
        ))}
      </div>
      <div aria-hidden="true" className={PRODUCT_BUTTONS}>
        <Block className={cn(BUY_BUTTON_SIZE, 'min-h-14 rounded-tile')} />
        {texts.telegram === null ? null : (
          // The Telegram button's box (its 1.5px border too) around its icon and label.
          <Block
            className={cn(
              LANDING_CTA_BOX,
              'border-[1.5px] border-transparent',
              TELEGRAM_BUTTON_SIZE,
            )}
          >
            <span className="size-[17px] flex-none" />
            <Ghost text={texts.telegram} />
          </Block>
        )}
      </div>
    </div>
  );
}
