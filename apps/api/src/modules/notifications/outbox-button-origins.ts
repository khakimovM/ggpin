import type { TgOutboxJob } from '@repo/shared';

/**
 * Which hosts an outbox button may open. The job schema (packages/shared) only checks the shape
 * and https; the origin is checked here because only the API knows its own URLs. A `web_app`
 * button hands our bot's signed initData to the page it opens, so a job edited in Redis must not
 * be able to point one at a foreign site (the initData would be replayable against our login).
 *
 * - `web_app`: the Mini App origin only (MINI_APP_URL).
 * - `url`: the Mini App or the website origin (MINI_APP_URL, WEB_URL).
 *
 * The raw string goes to Telegram as is, so it must be the canonical WHATWG form of itself and
 * carry no userinfo: `https://ggpin.uz\@evil.test/` parses here as ggpin.uz but an RFC 3986
 * parser in a Telegram client may read evil.test as the host. Producers build URLs with
 * `URL#toString()`, which is always canonical.
 */
export interface OutboxOriginConfig {
  readonly MINI_APP_URL?: string | undefined;
  readonly WEB_URL: string;
}

export interface OutboxButtonOrigins {
  readonly webApp: ReadonlySet<string>;
  readonly link: ReadonlySet<string>;
}

export function outboxButtonOrigins(config: OutboxOriginConfig): OutboxButtonOrigins {
  const miniApp = config.MINI_APP_URL === undefined ? [] : [new URL(config.MINI_APP_URL).origin];
  return {
    webApp: new Set(miniApp),
    link: new Set([...miniApp, new URL(config.WEB_URL).origin]),
  };
}

function opensOwnOrigin(raw: string, allowed: ReadonlySet<string>): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.href === raw && url.username === '' && url.password === '' && allowed.has(url.origin);
}

/** True when every url / web_app button of the job opens one of our own origins. */
export function hasOnlyOwnButtonLinks(job: TgOutboxJob, origins: OutboxButtonOrigins): boolean {
  for (const row of job.replyMarkup?.inline_keyboard ?? []) {
    for (const button of row) {
      if ('web_app' in button && !opensOwnOrigin(button.web_app.url, origins.webApp)) return false;
      if ('url' in button && !opensOwnOrigin(button.url, origins.link)) return false;
    }
  }
  return true;
}
