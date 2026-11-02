import type { TgOutboxJob } from '@repo/shared';

/** DI token for the outbox transport. Tests bind a fake so nothing reaches api.telegram.org. */
export const TG_OUTBOX_SENDER = Symbol('TG_OUTBOX_SENDER');

/**
 * How a validated outbox message leaves the process. Implementations throw grammY's
 * `GrammyError` / `HttpError` unchanged: the consumer maps them to retry decisions.
 */
export interface TgOutboxSender {
  send(job: TgOutboxJob): Promise<void>;
}
