import type { TgOutboxJob } from '@repo/shared';
import { GrammyError } from 'grammy';
import type { TgOutboxSender } from '../tg-outbox.sender';

export type Script = (job: TgOutboxJob, call: number) => Promise<void>;

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(25);
  }
}

export function telegramError(code: number, description: string, retryAfter?: number): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${code}: ${description})`,
    {
      ok: false,
      error_code: code,
      description,
      parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
    },
    'sendMessage',
    {},
  );
}

export interface Sent {
  readonly job: TgOutboxJob;
  readonly at: number;
}

export class FakeSender implements TgOutboxSender {
  readonly sent: Sent[] = [];
  readonly calls = new Map<string, number>();
  script: Script = () => Promise.resolve();

  async send(job: TgOutboxJob): Promise<void> {
    const call = (this.calls.get(job.chatId) ?? 0) + 1;
    this.calls.set(job.chatId, call);
    await this.script(job, call);
    this.sent.push({ job, at: Date.now() });
  }

  deliveriesTo(chatId: string): Sent[] {
    return this.sent.filter((s) => s.job.chatId === chatId);
  }
}
