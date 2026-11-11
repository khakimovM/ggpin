'use client';

import { useLocale, useTranslations } from 'next-intl';
import { BRAND } from '@repo/shared';
import { useEffect } from 'react';
import { homePath, storePath } from '../../i18n/paths';
import { subscribeAuthEvents } from '../../lib/api/auth-broadcast';
import { safeNextPath } from '../../lib/api/login-redirect';
import { hardNavigate } from '../../lib/navigation';
import { LoginCodePanel, LoginExpiredPanel } from './LoginCodePanel';
import { LoginRejectedPanel, LoginSuccessPanel } from './LoginEndPanels';
import { LoginShell } from './LoginShell';
import { LoginStartPanel } from './LoginStartPanel';
import { LoginWaitingPanel } from './LoginWaitingPanel';
import { useLoginFlow } from './use-login-flow';

/**
 * `/[locale]/login`: Telegram OTP sign-in. `next` is the raw query value; it is reduced to a
 * same-origin path by `safeNextPath` here, the one place that decides where a login leads.
 */
export function LoginFlow({ next }: { next: string | null }) {
  const t = useTranslations('web.login');
  const locale = useLocale();
  const flow = useLoginFlow();
  const { phase } = flow;

  const target = safeNextPath(next, storePath(locale));
  const succeeded = phase.name === 'success';
  useEffect(() => {
    // A full navigation, not a router push: the new session starts from a clean page.
    if (succeeded) hardNavigate(target);
  }, [succeeded, target]);

  // Signed in from another tab of this browser (the cookies are shared): this sign-in is moot, and
  // finishing it would open a second session. Go where it would have led.
  useEffect(
    () =>
      subscribeAuthEvents((type) => {
        if (type === 'signed-in') hardNavigate(target);
      }),
    [target],
  );

  return (
    <LoginShell
      homeHref={homePath(locale)}
      homeLabel={t('homeLabel', { brand: BRAND.name })}
      backLabel={t('back')}
      title={t('title', { brand: BRAND.name })}
      subtitle={t('subtitle')}
      securityNote={t('security')}
    >
      {phase.name === 'start' || phase.name === 'starting' ? (
        <LoginStartPanel
          starting={phase.name === 'starting'}
          problem={phase.name === 'start' ? phase.problem : null}
          onStart={flow.start}
        />
      ) : null}
      {phase.name === 'waiting' ? (
        <LoginWaitingPanel botUrl={phase.botUrl} onCancel={flow.reset} />
      ) : null}
      {phase.name === 'code' ? (
        <LoginCodePanel
          phase={phase}
          onSubmit={flow.submit}
          onEdited={flow.codeEdited}
          onElapsed={flow.codeExpired}
          onRestart={flow.start}
        />
      ) : null}
      {phase.name === 'expired' ? <LoginExpiredPanel onRestart={flow.start} /> : null}
      {phase.name === 'rejected' ? <LoginRejectedPanel onRestart={flow.start} /> : null}
      {phase.name === 'success' ? <LoginSuccessPanel displayName={phase.displayName} /> : null}
    </LoginShell>
  );
}
