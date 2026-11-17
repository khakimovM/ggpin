import { Icon } from '@repo/ui';
import { CircleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { formatCountdown } from '../../lib/format';
import { useCountdown } from '../../lib/use-countdown';
import type { LoginProblem } from './login-machine';

/** The red banner of Login.dc.html `state: error`, also used for a rate limit and no network. */
export function LoginProblemBanner({
  problem,
  step,
}: {
  problem: LoginProblem;
  step: 'start' | 'code';
}) {
  const t = useTranslations();
  const left = useCountdown(problem.kind === 'rateLimited' ? problem.until : null);
  const title =
    problem.kind === 'rateLimited'
      ? t('admin.login.error.rateLimited', { time: formatCountdown(left) })
      : problem.kind === 'network'
        ? t('admin.states.network')
        : step === 'code'
          ? t('admin.login.error.verifyFailed')
          : t('admin.login.error.title');
  const hint = problem.kind === 'generic' && step === 'start' ? t('admin.login.error.hint') : null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-sm leading-5 font-bold text-danger-text"
    >
      <Icon icon={CircleAlert} size={18} className="mt-px flex-none" />
      <span className="flex flex-col gap-0.5 tabular-nums">
        {title}
        {hint === null ? null : (
          <span className="font-medium text-foreground-secondary">{hint}</span>
        )}
      </span>
    </div>
  );
}
