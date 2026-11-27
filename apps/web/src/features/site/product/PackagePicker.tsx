'use client';

import { cn } from '@repo/ui';
import { SiteLink } from '../shell/SiteLink';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LANDING_CTA_PRIMARY } from '../landing/landing-styles';
import { LINK_FOCUS } from '../shell/nav-config';
import {
  BUY_BUTTON_SIZE,
  PICKER_CARD,
  PICKER_HEAD,
  PICKER_NOTE,
  PICKER_ROW,
  PICKER_ROWS,
  PRODUCT_BUTTONS,
} from './product-styles';

export interface PackageOption {
  id: string;
  /** The API's label, as it is ("500 ⭐"). */
  label: string;
  /** The price as the server sent it, already laid out by the server ("11 000 so‘m"); `null` draws none. */
  price: string | null;
  /** The text of the buy button while this package is chosen ("Sotib olish · 11 000 so‘m"). */
  cta: string;
}

export interface PackagePickerProps {
  /** The accessible name of the group ("Stars miqdori"). */
  label: string;
  amountHeading: string;
  priceHeading: string;
  options: readonly PackageOption[];
  /** Small print under the list (the price is an estimate, the amount may be typed in the store). */
  notes: readonly string[];
  /** Where the buy button leads. The package is not carried along: the store asks again. */
  buyHref: string;
  /** The buttons beside the buy button, drawn by the server. */
  children?: ReactNode;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The package list of a product page (Site.dc.html `radiogroup`): one tab stop, the arrows move
 * and choose (the WAI-ARIA radio group pattern), Home and End jump to the ends. The only thing the
 * browser does here is remember which row is chosen: every text, price included, arrives from the
 * server as a finished string, so nothing is calculated or formatted in the browser.
 */
export function PackagePicker({
  label,
  amountHeading,
  priceHeading,
  options,
  notes,
  buyHref,
  children,
}: PackagePickerProps) {
  const [selected, setSelected] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const current = options[selected] ?? options[0];

  function choose(index: number) {
    setSelected(index);
    rows.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = STEP[event.key];
    const last = options.length - 1;
    let next: number | null = null;
    if (step !== undefined) next = (index + step + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  // Nothing to choose from: a radio group with no radio, and a buy button with no label, say nothing.
  if (current === undefined) return null;

  return (
    <>
      <div className={PICKER_CARD}>
        <div aria-hidden="true" className={cn(PICKER_HEAD, 'text-foreground-muted')}>
          <span>{amountHeading}</span>
          <span>{priceHeading}</span>
        </div>
        <div role="radiogroup" aria-label={label} className={PICKER_ROWS}>
          {options.map((option, index) => {
            const on = index === selected;
            return (
              <button
                key={option.id}
                ref={(element) => {
                  rows.current[index] = element;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => setSelected(index)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  PICKER_ROW,
                  'cursor-pointer text-left text-foreground transition-[background-color,border-color] duration-fast hover:bg-muted motion-reduce:transition-none',
                  on
                    ? 'border-primary bg-primary-soft hover:bg-primary-soft'
                    : 'border-transparent',
                  LINK_FOCUS,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-5 flex-none rounded-full border-solid bg-card transition-[border-width] duration-base ease-spring motion-reduce:transition-none',
                    on ? 'border-[6px] border-primary' : 'border-2 border-input-border',
                  )}
                />
                <span className="min-w-0 text-base leading-[22px] font-extrabold tabular-nums">
                  {option.label}
                </span>
                {option.price === null ? null : (
                  <span className="ml-auto text-[15px] leading-[22px] text-right font-bold tabular-nums">
                    {option.price}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {notes.map((note) => (
          <p key={note} className={cn(PICKER_NOTE, 'text-foreground-muted')}>
            {note}
          </p>
        ))}
      </div>
      <div className={PRODUCT_BUTTONS}>
        <SiteLink
          href={buyHref}
          prefetch={false}
          className={cn(LANDING_CTA_PRIMARY, BUY_BUTTON_SIZE, 'tabular-nums')}
        >
          {current.cta}
        </SiteLink>
        {children}
      </div>
    </>
  );
}
