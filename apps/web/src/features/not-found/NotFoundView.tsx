import { Button } from '@repo/ui';
import Link from 'next/link';

interface NotFoundViewProps {
  title: string;
  body: string;
  ctaLabel: string;
  href: string;
}

/**
 * Site.dc.html `page: 404`: the big "404" in Unbounded (primary, the zero in the accent colour),
 * a heading, a sentence, and one way home. Shared by the website and the Mini App; the texts come
 * in as props (they are translated by whoever knows the language).
 */
export function NotFoundView({ title, body, ctaLabel, href }: NotFoundViewProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-16 pt-[max(64px,var(--tg-safe-top,0px))] pb-[max(64px,var(--tg-safe-bottom,0px))] text-foreground">
      <div className="flex max-w-[480px] flex-col items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="font-display text-[clamp(84px,18vw,140px)] leading-none font-bold tracking-[-.06em] text-primary"
        >
          4<span className="text-accent">0</span>4
        </span>
        <h1 className="m-0 text-2xl leading-[1.2] font-extrabold tracking-[-.02em] text-balance md:text-[32px]">
          {title}
        </h1>
        <p className="m-0 text-base leading-6 font-medium text-pretty text-foreground-secondary">
          {body}
        </p>
        <Button asChild size="lg" className="mt-2">
          <Link href={href}>{ctaLabel}</Link>
        </Button>
      </div>
    </main>
  );
}
