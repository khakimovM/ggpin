import { createHmac } from 'node:crypto';

// Runtime-built test bot tokens: no token-shaped literal sits in the source (gitleaks, hooks).
export const fixtureBotToken = (id = '123456', fill = 'a'): string =>
  [id, ':', 'AAH', fill.repeat(32)].join('');

export interface InitDataFixtureOptions {
  readonly botToken: string;
  readonly authDate: number; // seconds
  readonly user?: Record<string, unknown> | null; // null = omit the field
  readonly startParam?: string;
  readonly signature?: string;
  /** Extra raw fields, signed like the rest. */
  readonly extra?: Readonly<Record<string, string>>;
}

export const defaultUser = {
  id: 424242,
  first_name: 'Ann',
  username: 'ann_test',
  language_code: 'ru',
} as const;

/** Signs fields exactly like Telegram: data-check-string over everything but `hash`. */
export function signFields(botToken: string, fields: Readonly<Record<string, string>>): string {
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

export function buildInitDataFields(opts: InitDataFixtureOptions): Record<string, string> {
  const fields: Record<string, string> = {
    auth_date: String(opts.authDate),
    query_id: 'AAHtest',
    ...(opts.user === null ? {} : { user: JSON.stringify(opts.user ?? defaultUser) }),
    ...(opts.startParam !== undefined ? { start_param: opts.startParam } : {}),
    ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
    ...opts.extra,
  };
  return fields;
}

export function toInitData(fields: Readonly<Record<string, string>>, hash: string): string {
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function buildInitData(opts: InitDataFixtureOptions): string {
  const fields = buildInitDataFields(opts);
  return toInitData(fields, signFields(opts.botToken, fields));
}
