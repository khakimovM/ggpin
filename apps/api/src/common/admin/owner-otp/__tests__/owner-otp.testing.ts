import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUES } from '@repo/shared';
import type { Job, Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../../../config/config.module';
import { RedisService } from '../../../../infra/redis/redis.service';
import { TgOutboxEnqueuer } from '../../../../modules/notifications/tg-outbox.enqueuer';
import type { OtpAnswer, OwnerOtpScope } from '../owner-otp';
import { OwnerOtpIssuer } from '../owner-otp.issuer';

// Test-only access to the owner's code: the tests play the owner reading the bot message, so
// they read the text of the waiting tg-outbox job (no worker consumes it in e2e). Synthetic chat.

export const TEST_OWNER_CHAT_ID = '700000001';

type App = Pick<INestApplicationContext, 'get'>;

const CODE_IN_TEXT = /: (\d{6})\n/;

export function outboxQueue(app: App): Queue {
  return app.get<Queue>(getQueueToken(QUEUES.TG_OUTBOX), { strict: false });
}

/** An issuer on the app's Redis and outbox; suites whose env has no owner chat get a test one. */
export function testIssuer(app: App): OwnerOtpIssuer {
  const config = app.get<AppConfig>(APP_CONFIG, { strict: false });
  return new OwnerOtpIssuer(
    app.get(RedisService, { strict: false }),
    app.get(TgOutboxEnqueuer, { strict: false }),
    { ...config, OWNER_ALERT_CHAT_ID: config.OWNER_ALERT_CHAT_ID ?? TEST_OWNER_CHAT_ID },
  );
}

function textOf(job: Job | undefined): string {
  const data: unknown = job?.data;
  if (typeof data !== 'object' || data === null || !('text' in data)) return '';
  return typeof data.text === 'string' ? data.text : '';
}

export function codeIn(text: string): string {
  const match = CODE_IN_TEXT.exec(text);
  if (match?.[1] === undefined) throw new Error('no owner code in the message');
  return match[1];
}

/** The newest waiting owner-code message naming `target` (the CLI holds the challenge id). */
export async function sentMessageFor(app: App, target: string): Promise<Job> {
  const jobs = await outboxQueue(app).getJobs(['waiting', 'delayed', 'prioritized']);
  const mine = jobs
    .filter((j) => (j.id ?? '').startsWith('owner-otp-') && textOf(j).includes(target))
    .sort((a, b) => b.timestamp - a.timestamp);
  const job = mine[0];
  if (job === undefined) throw new Error(`no owner code message for ${target}`);
  return job;
}

export async function sentCodeFor(app: App, target: string): Promise<string> {
  return codeIn(textOf(await sentMessageFor(app, target)));
}

/** Issues a code for `scope` and reads it back, as the owner would from the bot (job removed). */
export async function ownerCode(app: App, scope: OwnerOtpScope): Promise<OtpAnswer> {
  const challenge = await testIssuer(app).issue(scope);
  const job = await sentMessageFor(app, scope.target);
  const code = codeIn(textOf(job));
  await job.remove();
  return { challengeId: challenge.challengeId, code };
}
