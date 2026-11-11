import type { ConfirmState } from './ConfirmSheet';

/** Which handler the button runs; the component maps it to its own function. */
export type MainButtonRun = 'pay' | 'check' | 'renew' | 'proceed' | 'none';

export interface MainButtonAction {
  text: string;
  enabled: boolean;
  loading: boolean;
  visible: boolean;
  run: MainButtonRun;
}

export interface MainButtonLabels {
  pay: string;
  check: string;
  renew: string;
  proceed: string;
  retry: string;
}

/**
 * What Telegram's MainButton shows and does in each state of the confirmation (in the browser the
 * sheet draws its own button for the same state). A failed state has no button.
 */
export function mainButtonAction(
  state: ConfirmState,
  labels: MainButtonLabels,
  { paying, checkBlocked }: { paying: boolean; checkBlocked: boolean },
): MainButtonAction {
  switch (state) {
    case 'ready':
    case 'paying':
      return {
        text: labels.pay,
        enabled: state === 'ready',
        loading: state === 'paying',
        visible: true,
        run: 'pay',
      };
    case 'uncertain':
      return {
        text: labels.check,
        enabled: !paying && !checkBlocked,
        loading: paying,
        visible: true,
        run: 'check',
      };
    case 'expired':
    case 'refreshing':
      return {
        text: labels.renew,
        enabled: state === 'expired',
        loading: state === 'refreshing',
        visible: true,
        run: 'renew',
      };
    case 'renewed':
      return {
        text: labels.proceed,
        enabled: true,
        loading: false,
        visible: true,
        run: 'proceed',
      };
    case 'failed':
      return { text: labels.retry, enabled: true, loading: false, visible: false, run: 'none' };
  }
}
