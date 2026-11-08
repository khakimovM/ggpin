'use client';

import { Button, Sheet } from '@repo/ui';
import { useTranslations } from 'next-intl';

export interface HowToFindSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The catalog's `help` text for the visitor's language. */
  help: string;
}

/** One non-empty line per step; a text with a single line is one paragraph. */
export function helpSteps(help: string): string[] {
  return help
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * "Qanday topaman?" (Product.dc.html `sheet`). The text is the catalog's `help` and reaches the
 * page only as text nodes: it is data from the server, so it is never parsed as HTML.
 */
export function HowToFindSheet({ open, onOpenChange, help }: HowToFindSheetProps) {
  const t = useTranslations('store.product.help');
  const steps = helpSteps(help);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      footer={
        <Button size="lg" className="w-full" onClick={() => onOpenChange(false)}>
          {t('close')}
        </Button>
      }
    >
      {steps.length > 1 ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {steps.map((step, index) => (
            <li
              key={`${index}-${step}`}
              className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3"
            >
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-primary text-xs font-extrabold text-primary-foreground"
              >
                {index + 1}
              </span>
              <span className="text-sm leading-5 font-semibold text-pretty">{step}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-sm leading-5 font-semibold text-pretty">{steps[0] ?? ''}</p>
      )}
    </Sheet>
  );
}
