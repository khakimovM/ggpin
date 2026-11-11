'use client';

import { BRAND } from '@repo/shared';
import { Accordion } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

const FAQ = [1, 2, 3, 4, 5, 6] as const;

/** The questions of Account.dc.html `faqs`: one open at a time, the first one open at the start. */
export function FaqList() {
  const t = useTranslations('account.help.faq');
  const [open, setOpen] = useState('q1');
  return (
    <Accordion
      value={open}
      onValueChange={setOpen}
      headingLevel={2}
      className="rounded-3xl"
      items={FAQ.map((n) => ({
        value: `q${n}`,
        question: t(`q${n}`),
        answer: t(`a${n}`, { brand: BRAND.name }),
      }))}
    />
  );
}
