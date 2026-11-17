import { Button, Icon, Spinner, cn } from '@repo/ui';
import { Check, CircleX, ExternalLink, RefreshCw, RotateCcw, Send, TimerOff } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useCountdown } from '../../lib/use-countdown';
import type { LoginProblem } from './login-machine';
import { LoginProblemBanner } from './LoginProblemBanner';

const BIG = 'h-14 w-full rounded-tile text-base font-extrabold shadow-glow';

/** Design `state`: start, loading (`starting`) and error (`problem`). */
export function LoginStartPanel({
  starting,
  problem,
  onStart,
}: {
  starting: boolean;
  problem: LoginProblem | null;
  onStart: () => void;
}) {
  const t = useTranslations();
  const waiting = useCountdown(problem?.kind === 'rateLimited' ? problem.until : null) > 0;
  return (
    <>
      {problem === null ? null : <LoginProblemBanner problem={problem} step="start" />}
      <Button className={BIG} loading={starting} disabled={waiting} onClick={onStart}>
        {starting ? null : <Icon icon={Send} size={19} />}
        {starting ? t('admin.login.starting') : t('admin.login.start')}
      </Button>
    </>
  );
}

const STEP_DOT = 'grid size-7 flex-none place-items-center rounded-full text-xs font-extrabold';

/** Design `state: waiting`: the three steps, the bot link and the polling notice. */
export function LoginWaitingPanel({ botUrl, onCancel }: { botUrl: string; onCancel: () => void }) {
  const t = useTranslations();
  return (
    <>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        <li className="flex items-start gap-3 text-[15px] leading-[22px] font-semibold">
          <span className={cn(STEP_DOT, 'bg-success text-card')}>
            <Icon icon={Check} size={14} />
          </span>
          <span className="pt-[3px]">1. {t('admin.login.steps.open')}</span>
        </li>
        <li className="flex items-start gap-3 text-[15px] leading-[22px] font-bold">
          <span
            className={cn(
              STEP_DOT,
              'bg-primary-soft text-primary-soft-foreground ring-[1.5px] ring-primary',
            )}
          >
            2
          </span>
          <span className="pt-[3px]">2. {t('admin.login.steps.start')}</span>
        </li>
        <li className="flex items-start gap-3 text-[15px] leading-[22px] font-semibold text-foreground-secondary">
          <span className={cn(STEP_DOT, 'bg-muted text-foreground-muted')}>3</span>
          <span className="pt-[3px]">3. {t('admin.login.steps.enter')}</span>
        </li>
      </ol>
      <Button
        asChild
        variant="outline"
        className="h-[52px] w-full rounded-tile text-[15px] font-extrabold"
      >
        <a href={botUrl} target="_blank" rel="noopener noreferrer">
          <Icon icon={ExternalLink} size={17} />
          {t('admin.login.openTelegram')}
        </a>
      </Button>
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 text-sm leading-5 font-semibold text-info-text"
      >
        <Spinner size={16} />
        {t('admin.login.waiting')}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="self-center text-foreground-muted"
        onClick={onCancel}
      >
        {t('admin.login.cancel')}
      </Button>
    </>
  );
}

export function LoginExpiredPanel({ onRestart }: { onRestart: () => void }) {
  const t = useTranslations();
  return (
    <>
      <div
        role="alert"
        className="flex items-center justify-center gap-1.5 text-[13px] leading-[18px] font-bold text-warning-text"
      >
        <Icon icon={TimerOff} size={15} />
        {t('admin.login.expired')}
      </div>
      <Button className={BIG} onClick={onRestart}>
        <Icon icon={RefreshCw} size={17} />
        {t('admin.login.newCode')}
      </Button>
    </>
  );
}

export function LoginRejectedPanel({ onRestart }: { onRestart: () => void }) {
  const t = useTranslations();
  return (
    <>
      <div role="alert" className="flex flex-col items-center gap-3 py-1 text-center">
        <span className="grid size-16 place-items-center rounded-full bg-danger-soft text-danger">
          <Icon icon={CircleX} size={30} />
        </span>
        <span className="text-[17px] leading-6 font-extrabold">
          {t('admin.login.rejected.title')}
        </span>
        <span className="text-sm leading-5 font-medium text-foreground-secondary">
          {t('admin.login.rejected.hint')}
        </span>
      </div>
      <Button className={BIG} onClick={onRestart}>
        <Icon icon={RotateCcw} size={17} />
        {t('admin.login.restart')}
      </Button>
    </>
  );
}

export function LoginSuccessPanel() {
  const t = useTranslations();
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 text-sm leading-5 font-semibold text-foreground-muted"
    >
      <Spinner size={16} />
      {t('admin.login.success')}
    </div>
  );
}
