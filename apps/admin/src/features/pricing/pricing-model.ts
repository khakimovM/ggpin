import type { ADMIN_SETTING_KEYS, AdminFxRate } from '@repo/shared';
import { formatShortDate, ratioOf } from '../../lib/format';

export type SettingKey = (typeof ADMIN_SETTING_KEYS)[number];

/** The cards of the settings screen (AdminOps.dc.html `pricing`), in reading order. */
export const SETTING_GROUPS: readonly {
  id: 'topup' | 'price' | 'admin';
  keys: readonly SettingKey[];
}[] = [
  {
    id: 'topup',
    keys: [
      'TOPUP_MIN_TIYIN',
      'TOPUP_MAX_TIYIN',
      'TOPUP_STEP_TIYIN',
      'TOPUP_DAILY_MAX_TIYIN',
      'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
    ],
  },
  {
    id: 'price',
    keys: ['PRICE_TOLERANCE_BPS', 'QUOTE_TTL_MS', 'FX_MAX_AGE_MS', 'FX_MAX_JUMP_BPS'],
  },
  {
    id: 'admin',
    keys: [
      'ADMIN_CONFIRM_THRESHOLD_TIYIN',
      'ADMIN_OPERATOR_REFUND_MAX_TIYIN',
      'ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN',
      'ADMIN_OTP_DAILY_MAX',
    ],
  },
];

const SCALE = 6;

/** A decimal rate ("12655.5") as an integer of millionths, so the chart never parses floats. */
export function scaledRate(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE));
}

const UNIT = 10n ** BigInt(SCALE);

const HUNDREDTH = UNIT / 100n;

/**
 * A scaled rate back as a decimal axis text, two fraction digits at most: "12655.5", "3.41".
 * `up` rounds a cut-off remainder up (the top text must never sit below the highest point).
 */
export function rateLabel(scaled: bigint, up = false): string {
  const cut = scaled % HUNDREDTH;
  const rounded = up && cut !== 0n ? scaled - cut + HUNDREDTH : scaled - cut;
  const whole = rounded / UNIT;
  const hundredths = (rounded % UNIT) / HUNDREDTH;
  if (hundredths === 0n) return whole.toString();
  return `${whole}.${hundredths.toString().padStart(2, '0').replace(/0$/, '')}`;
}

export interface RateSeries {
  ratios: number[];
  /** Axis texts top / middle / bottom on the same scale as the line: max, (min+max)/2, min. */
  yLabels: [string, string, string];
  xLabels: string[];
}

/**
 * Chart ratios of a rate series, oldest first: the lowest rate is the bottom of the chart and the
 * highest its top, so a small move still fills the height and the axis texts (max / middle / min)
 * sit exactly where the line would cross them (R-4). Equal rates draw a flat line in the middle.
 */
export function rateSeries(rows: readonly AdminFxRate[]): RateSeries {
  const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const values = ordered.map((row) => scaledRate(row.rate));
  const min = values.reduce((a, b) => (b < a ? b : a), values[0] ?? 0n);
  const max = values.reduce((a, b) => (b > a ? b : a), values[0] ?? 0n);
  const span = max - min;
  const ratios = values.map((value) => (span === 0n ? 0.5 : ratioOf(value - min, span)));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    ratios,
    yLabels: [rateLabel(max, true), rateLabel((min + max) / 2n), rateLabel(min)],
    xLabels:
      first && last ? [formatShortDate(first.createdAt), formatShortDate(last.createdAt)] : [],
  };
}
