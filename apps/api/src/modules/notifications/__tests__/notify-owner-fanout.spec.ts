import { tgOutboxJobSchema, type NotifyJob, type TgOutboxJob } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { NotifyConsumer, OwnerChatMissingError } from '../notify.consumer';
import type { OwnerAlertRenderer } from '../owner-alert.renderer';
import type { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';

// Owner alerts reach every partner (D-53). Synthetic chat ids only.
const PRIMARY = '111111111';
const PARTNER = '222222222';
const ALERT = {
  kind: 'OWNER_ALERT',
  alert: 'chainBreak',
  refId: 'r9',
} as const satisfies NotifyJob;

function setup(chatIds: string | undefined, failFor: readonly string[] = []) {
  const sent: { id: string; job: TgOutboxJob }[] = [];
  const attempted: string[] = [];
  const outbox = {
    enqueue: (id: string, job: TgOutboxJob) => {
      attempted.push(job.chatId);
      if (failFor.includes(job.chatId)) return Promise.reject(new Error('redis hiccup'));
      sent.push({ id, job: tgOutboxJobSchema.parse(job) });
      return Promise.resolve();
    },
  } as unknown as TgOutboxEnqueuer;
  const alerts = { render: () => Promise.resolve('alert text') } as unknown as OwnerAlertRenderer;
  const config = buildTestEnv(chatIds === undefined ? {} : { OWNER_ALERT_CHAT_ID: chatIds });
  const consumer = new NotifyConsumer({} as NotifySourcesRepository, alerts, outbox, config);
  return { consumer, sent, attempted };
}

describe('owner alert fan-out (D-53)', () => {
  it('one outbox job per recipient, same text, the chat id in each job id', async () => {
    const { consumer, sent } = setup(`${PRIMARY},${PARTNER}`);
    await expect(consumer.handle({ id: 'n1', data: ALERT })).resolves.toBe('queued');
    expect(sent.map((s) => s.job.chatId)).toEqual([PRIMARY, PARTNER]);
    expect(sent.map((s) => s.id)).toEqual([
      `alert-chainBreak-r9-${PRIMARY}`,
      `alert-chainBreak-r9-${PARTNER}`,
    ]);
    expect(new Set(sent.map((s) => s.job.text))).toEqual(new Set(['alert text']));
  });

  it('a single id behaves like one recipient', async () => {
    const { consumer, sent } = setup(PRIMARY);
    await consumer.handle({ id: 'n1', data: ALERT });
    expect(sent.map((s) => s.job.chatId)).toEqual([PRIMARY]);
  });

  it('the same id listed twice is sent once (the env parse drops repeats)', async () => {
    const { consumer, sent } = setup(`${PRIMARY},${PARTNER},${PRIMARY}`);
    await consumer.handle({ id: 'n1', data: ALERT });
    expect(sent).toHaveLength(2);
  });

  it('one recipient failing does not stop the others, and the job fails so it is retried', async () => {
    const { consumer, sent, attempted } = setup(`${PRIMARY},${PARTNER}`, [PRIMARY]);
    await expect(consumer.handle({ id: 'n1', data: ALERT })).rejects.toThrow('redis hiccup');
    expect(attempted).toEqual([PRIMARY, PARTNER]); // the partner was still tried
    expect(sent.map((s) => s.job.chatId)).toEqual([PARTNER]);
  });

  it('without a configured chat the alert job fails and nothing is queued', async () => {
    const { consumer, attempted } = setup(undefined);
    await expect(consumer.handle({ id: 'n1', data: ALERT })).rejects.toBeInstanceOf(
      OwnerChatMissingError,
    );
    expect(attempted).toEqual([]);
  });
});
