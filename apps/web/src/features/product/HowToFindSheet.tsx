'use client';

import { Button, Sheet } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { HelpSteps } from './HelpSteps';

export interface HowToFindSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The catalog's `help` text for the visitor's language. */
  help: string;
}

export { helpSteps } from './HelpSteps';

/**
 * "Qanday topaman?" (Product.dc.html `sheet`). The text is the catalog's `help` and reaches the
 * page only as text nodes: it is data from the server, so it is never parsed as HTML.
 */
export function HowToFindSheet({ open, onOpenChange, help }: HowToFindSheetProps) {
  const t = useTranslations('store.product.help');
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
      <HelpSteps help={help} />
    </Sheet>
  );
}
