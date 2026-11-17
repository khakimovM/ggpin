import { BRAND } from '@repo/shared';
import { Icon, Logo } from '@repo/ui';
import { Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Navigate, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';
import { homePathFor, sectionOf } from '../../app/sections';
import type { LoginLocationState } from '../../app/RootLayout';
import { EnvBadge } from '../../app/shell/EnvBadge';
import { env } from '../../env';
import { LoginCodePanel } from './LoginCodePanel';
import {
  LoginExpiredPanel,
  LoginRejectedPanel,
  LoginStartPanel,
  LoginSuccessPanel,
  LoginWaitingPanel,
} from './LoginPanels';
import { useAdminSession } from './use-admin-session';
import { useLoginFlow } from './use-login-flow';

function stateOf(value: unknown): LoginLocationState {
  if (typeof value !== 'object' || value === null) return {};
  const { from, ended } = value as Record<string, unknown>;
  return {
    from: typeof from === 'string' ? from : undefined,
    ended: ended === true,
  };
}

/** Only a path of one of our own sections may be the target after login (no open redirect). */
function safeTarget(from: string | undefined): string | undefined {
  if (from === undefined || !from.startsWith('/') || from.startsWith('//')) return undefined;
  return sectionOf(from) === undefined ? undefined : from;
}

/** `/login` — Login.dc.html `variant: admin`: Telegram OTP through the bot's `admin_` payload. */
export function LoginPage() {
  const t = useTranslations();
  const location = useLocation();
  const session = useAdminSession();
  const flow = useLoginFlow();
  const { phase } = flow;
  const routerState = stateOf(location.state);

  if (session.data) {
    const target = safeTarget(routerState.from) ?? homePathFor(session.data.permissions);
    return <Navigate to={target} replace />;
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-[30%] left-1/2 h-[900px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--primary-soft),transparent)]"
      />
      <header className="relative mx-auto flex h-16 w-full max-w-[1264px] items-center justify-between gap-4 px-4 md:px-8 lg:h-[72px]">
        <span className="flex items-center gap-2.5">
          <Logo variant="mark" size={32} name={BRAND.name} decorative />
          <Logo variant="wordmark" size={20} name={BRAND.name} />
        </span>
        <EnvBadge label={env.VITE_ENV_LABEL} className="h-7 rounded-badge" />
      </header>
      <main className="relative grid flex-1 place-items-center px-4 pt-4 pb-8 md:pt-12 md:pb-16">
        <div className="flex w-[min(100%,440px)] flex-col gap-[22px] rounded-2xl border border-border bg-card px-5 py-6 shadow-lg md:px-9 md:py-9">
          <div className="flex flex-col items-center gap-3.5 text-center">
            <Logo variant="mark" size={56} name={BRAND.name} decorative className="shadow-glow" />
            <h1 className="m-0 text-[26px] leading-8 font-extrabold tracking-[-.02em]">
              {t('admin.login.title')}
            </h1>
            <p className="m-0 text-[15px] leading-[22px] font-medium text-pretty text-foreground-secondary">
              {t('admin.login.subtitle', { brand: BRAND.name })}
            </p>
            <div
              role="note"
              className="mt-1 flex items-center justify-center gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-[13px] leading-[18px] font-bold text-warning-text"
            >
              <Icon icon={ShieldAlert} size={16} className="flex-none" />
              {t('admin.login.staffOnly')}
            </div>
          </div>
          {routerState.ended && phase.name === 'start' && phase.problem === null ? (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-md bg-info-soft px-3.5 py-3 text-sm leading-5 font-bold text-info-text"
            >
              <Icon icon={Info} size={18} className="mt-px flex-none" />
              {t('admin.login.sessionEnded')}
            </div>
          ) : null}
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
          {phase.name === 'success' ? <LoginSuccessPanel /> : null}
          <div className="flex items-start gap-2.5 border-t border-border pt-[18px] text-[13px] leading-[19px] font-semibold text-foreground-secondary">
            <Icon icon={ShieldCheck} size={18} className="mt-px flex-none text-success" />
            {t('admin.login.security')}
          </div>
        </div>
      </main>
    </div>
  );
}
