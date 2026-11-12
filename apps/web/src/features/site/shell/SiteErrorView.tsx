'use client';

import { Button, cn, Icon } from '@repo/ui';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Site.dc.html `page: error`: a red circle with a warning sign, the heading, one sentence that
 * says the orders and the wallet are safe, and one button. Shown by the `error.tsx` boundaries of
 * the website when a page throws while rendering. `fullPage` is for the boundary that has no site
 * chrome around it (the store, the sign-in page); inside the marketing pages the header and the
 * footer stay and the view only fills the space between them.
 *
 * The button re-fetches the server part and then retries the render: `reset()` alone would only
 * re-render with the same server result, so a failure on the server could not recover.
 */
export function SiteErrorView({ reset, fullPage }: { reset: () => void; fullPage: boolean }) {
  const t = useTranslations('site.error');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <main
      className={cn(
        'grid place-items-center bg-background px-4 text-foreground',
        fullPage ? 'min-h-dvh py-16' : 'min-h-[clamp(560px,46vw,680px)] py-[clamp(40px,6vw,80px)]',
      )}
    >
      <div role="alert" className="flex max-w-[480px] flex-col items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="grid size-20 place-items-center rounded-full bg-danger-soft text-danger"
        >
          <Icon icon={TriangleAlert} size={36} />
        </span>
        <h1 className="m-0 text-2xl leading-[1.2] font-extrabold tracking-[-.02em] text-balance md:text-[32px]">
          {t('title')}
        </h1>
        <p className="m-0 text-base leading-6 font-medium text-pretty text-foreground-secondary">
          {t('body')}
        </p>
        <Button
          type="button"
          loading={pending}
          onClick={retry}
          className="mt-2 min-h-12 rounded-md px-5 text-[15px] font-extrabold"
        >
          <Icon icon={RefreshCw} size={17} />
          {t('reload')}
        </Button>
      </div>
    </main>
  );
}
