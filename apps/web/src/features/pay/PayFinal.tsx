'use client';

import { Icon } from '@repo/ui';
import { Check, CircleX, Info, Link2Off, TimerOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { SuccessBurst } from '../order/SuccessBurst';

export type PayFinalKind = 'credited' | 'expired' | 'cancelled' | 'invalid' | 'done';

export interface PayFinalProps {
  kind: PayFinalKind;
  /** Plays the confetti once per request (the same flag the order page uses). */
  burstId?: string;
  /** "+50 347 so'm", already formatted, for `credited`. */
  creditedText?: string;
  /** Whose account was topped up ("S***r"), for `credited` on the public page. */
  ownerHint?: string | null;
  /** The buttons under the message. */
  actions: ReactNode;
  /** The page has one h1; inside a dialog (already titled) the heading is an h2. */
  heading?: 'h1' | 'h2';
}

const ICON = { expired: TimerOff, cancelled: CircleX, invalid: Link2Off, done: Info } as const;

/**
 * The end of a payment (PayPage.dc.html `credited`, `expired`, `cancelled`, `invalid`): a round
 * mark, one heading, what it means, and the way on. "Expired" reassures that money sent in time is
 * still credited; the success state adds the confetti and the credited amount.
 */
export function PayFinal({
  kind,
  burstId,
  creditedText,
  ownerHint = null,
  actions,
  heading = 'h1',
}: PayFinalProps) {
  const Heading = heading;
  const t = useTranslations('pay');
  const ok = kind === 'credited';
  // What the visitor should know next. A request that is over, or a link that no longer works, may
  // still have been paid: those two screens say where to go with that.
  const lines =
    kind === 'expired'
      ? [t('expired.body')]
      : kind === 'invalid'
        ? [t('invalid.body'), t('invalid.hint'), t('paidHelp')]
        : kind === 'cancelled'
          ? [t('paidHelp')]
          : kind === 'done'
            ? [t('done.body')]
            : [];
  return (
    <section
      role="status"
      data-final={kind}
      className="relative flex flex-1 flex-col items-center justify-center gap-3 px-2 py-12 text-center"
    >
      {ok && burstId !== undefined ? <SuccessBurst orderId={burstId} /> : null}
      {ok ? (
        <span
          aria-hidden="true"
          className="grid size-[88px] animate-[gg-pop_var(--dur-slower)_var(--ease-spring)_both] place-items-center rounded-full bg-success text-white motion-reduce:animate-none"
        >
          <Icon icon={Check} size={42} />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={`grid size-20 place-items-center rounded-full ${
            kind === 'expired'
              ? 'bg-info-soft text-info-text'
              : 'bg-muted text-foreground-secondary'
          }`}
        >
          <Icon icon={ICON[kind]} size={34} />
        </span>
      )}
      <Heading
        id="pay-title"
        className="m-0 mt-2 max-w-[420px] text-2xl leading-[30px] font-extrabold text-balance"
      >
        {t(`${kind}.title`)}
      </Heading>
      {ok ? (
        <span className="flex flex-col text-base leading-6 font-bold tabular-nums">
          <span className="text-success-text">{creditedText}</span>
          <span className="text-foreground-secondary">{t('credited.sub')}</span>
          {ownerHint === null ? null : (
            <span data-testid="pay-credited-owner" className="text-sm text-foreground-secondary">
              {t('owner', { hint: ownerHint })}
            </span>
          )}
        </span>
      ) : null}
      {lines.length === 0 ? null : (
        <div
          className={`flex max-w-[400px] flex-col gap-1.5 rounded-[14px] px-3.5 py-3 text-sm leading-5 font-semibold text-pretty ${
            kind === 'expired'
              ? 'bg-info-soft text-info-text'
              : 'bg-muted text-foreground-secondary'
          }`}
        >
          {lines.map((line) => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
        </div>
      )}
      <div className="mt-4 flex w-full max-w-[360px] flex-col gap-1.5">{actions}</div>
    </section>
  );
}
