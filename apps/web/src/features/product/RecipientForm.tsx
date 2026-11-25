'use client';

import type { InputField } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { Ban, CircleHelp, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCountdown } from '../auth/use-countdown';
import { RecipientChecking } from './RecipientChecking';
import { RecipientConfirmed } from './RecipientConfirmed';
import { RecipientDown } from './RecipientDown';
import { RecipientFound } from './RecipientFound';
import { RecipientWarnings } from './RecipientWarnings';
import { RecipientInput } from './input-fields';
import { sameRecipient } from './recipient-machine';
import type { RecipientControls } from './use-validate-recipient';

export interface RecipientFormProps {
  field: InputField;
  controls: RecipientControls;
  /** The visitor's own username, for the "O‘zim" shortcut. */
  ownUsername: string | null;
  /** The catalog's `help` text exists: show "Qanday topaman?". */
  hasHelp: boolean;
  onHelp: () => void;
}

/**
 * "Kimga yuboramiz?" (Product.dc.html `recipient`: idle, checking, found, confirmed, notfound,
 * invalid, down, plus the premium notes: the blocking `blocked` and the non-blocking warnings;
 * `busy` reuses the down note with its own text, the handoff has no state of its own for it).
 * Every message is text with an icon, never a colour alone.
 */
export function RecipientForm({
  field,
  controls,
  ownUsername,
  hasHelp,
  onHelp,
}: RecipientFormProps) {
  const t = useTranslations('store.product');
  const { state, canonical, setUsername, check, confirm, reset } = controls;
  const { phase, found, username } = state;
  const editing = phase !== 'found' && phase !== 'confirmed';
  const checking = phase === 'checking';
  // While the server said "busy", the main button is off too (a tap would do nothing); it comes
  // back with the note's retry button when Retry-After has passed.
  const busyLeftMs = useCountdown(phase === 'busy' ? state.retryAt : null);
  const waiting = phase === 'busy' && busyLeftMs > 0;
  const fieldError =
    phase === 'invalid'
      ? t('recipient.invalid')
      : phase === 'notfound'
        ? t('recipient.notFound')
        : undefined;

  return (
    <section
      aria-labelledby="recipient-title"
      className="flex flex-col gap-3 rounded-[24px] border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="recipient-title" className="m-0 text-[17px] leading-[22px] font-extrabold">
          {t('recipient.title')}
        </h2>
        {hasHelp ? (
          <Button variant="secondary" size="sm" onClick={onHelp} className="min-h-8 rounded-full">
            <Icon icon={CircleHelp} size={14} />
            {t('help.open')}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <RecipientInput
              field={field}
              value={username}
              onValueChange={setUsername}
              onSubmit={check}
              error={fieldError}
              disabled={checking}
            />
            <Button
              onClick={check}
              disabled={username === '' || checking || waiting}
              loading={checking}
              className="mt-6 h-12 self-start"
            >
              {t('recipient.check')}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
              {t('recipient.hint')}
            </span>
            {ownUsername !== null && !sameRecipient(ownUsername, username) ? (
              <Button variant="link" size="sm" onClick={() => setUsername(ownUsername)}>
                {t('recipient.self')}
              </Button>
            ) : null}
          </div>
          {checking ? <RecipientChecking /> : null}
          {phase === 'down' || phase === 'busy' ? (
            <RecipientDown reason={phase} onRetry={check} retryAt={state.retryAt} />
          ) : null}
          {phase === 'expired' ? (
            <div
              role="alert"
              className="flex items-center gap-2.5 rounded-[14px] bg-info-soft py-2.5 pr-2.5 pl-3 text-[13px] leading-[18px] font-bold text-info-text"
            >
              <Icon icon={Info} size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">{t('recipient.expired')}</span>
            </div>
          ) : null}
        </>
      ) : null}

      {phase === 'found' && found && canonical !== null ? (
        <RecipientFound
          recipient={found}
          username={canonical}
          onChange={reset}
          onConfirm={confirm}
        />
      ) : null}
      {phase === 'confirmed' && found && canonical !== null ? (
        <RecipientConfirmed recipient={found} username={canonical} onChange={reset} />
      ) : null}
      {!editing && found ? <RecipientWarnings warnings={found.warnings} /> : null}

      {phase === 'blocked' ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[14px] bg-danger-soft p-3 text-[13px] leading-[19px] font-bold text-danger-text"
        >
          <Icon icon={Ban} size={17} className="mt-px shrink-0" />
          <span className="flex flex-col gap-0.5">
            {t('recipient.blocked.title')}
            <span className="font-medium text-foreground-secondary">
              {t('recipient.blocked.body')}
            </span>
          </span>
        </div>
      ) : null}
    </section>
  );
}
