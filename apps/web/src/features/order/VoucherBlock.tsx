'use client';

import { Icon } from '@repo/ui';
import { Check, Copy, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

const COPIED_MS = 2000;

/**
 * Whether the browser let us write to the clipboard. `navigator.clipboard` is missing in an
 * insecure context and can refuse without a user gesture; either way the code stays on screen to
 * be selected by hand, so a failure is quiet.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gift-card code of a delivered voucher order (Checkout.dc.html `order: voucher`). The code is
 * a secret: it lives in the query cache in memory only, is shown as text (never as HTML), and is
 * written to no URL, log, storage or analytics.
 */
export function VoucherBlock({ code }: { code: string }) {
  const t = useTranslations('store.order.voucher');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (!(await writeClipboard(code))) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <section className="flex flex-col gap-3 rounded-[24px] border border-border bg-card p-4">
      <span className="text-xs leading-4 font-bold tracking-[.06em] text-foreground-muted uppercase">
        {t('label')}
      </span>
      <div className="flex items-center gap-2 rounded-2xl border-[1.5px] border-dashed border-accent bg-accent-soft py-3 pr-2 pl-4">
        <span
          data-testid="voucher-code"
          className="min-w-0 flex-1 font-mono text-[19px] leading-[26px] font-bold tracking-[.06em] [overflow-wrap:anywhere] select-all"
        >
          {code}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex h-11 min-w-[124px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-card px-3 text-[13px] font-extrabold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {copied ? (
            <>
              <Icon icon={Check} size={15} className="text-success-text" />
              <span className="text-success-text" role="status">
                {t('copied')}
              </span>
            </>
          ) : (
            <>
              <Icon icon={Copy} size={15} />
              {t('copy')}
            </>
          )}
        </button>
      </div>
      <div
        role="note"
        className="flex items-center gap-2 rounded-[14px] bg-danger-soft px-3 py-2.5 text-[13px] leading-[18px] font-bold text-danger-text"
      >
        <Icon icon={EyeOff} size={16} className="shrink-0" />
        {t('hide')}
      </div>
    </section>
  );
}
