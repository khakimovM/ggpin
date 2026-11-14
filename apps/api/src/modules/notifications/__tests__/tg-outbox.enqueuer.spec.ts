import { TG_OUTBOX_PRIORITY, tgOutboxJobId } from '@repo/shared';
import type { Queue } from 'bullmq';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';

function setup() {
  const add = jest.fn().mockResolvedValue(undefined);
  return { add, enqueuer: new TgOutboxEnqueuer({ add } as unknown as Queue) };
}

describe('TgOutboxEnqueuer', () => {
  it('adds the validated job with messageId as the BullMQ jobId', async () => {
    const { add, enqueuer } = setup();
    const id = tgOutboxJobId('order', 'abc123', 'delivered');
    await enqueuer.enqueue(id, { chatId: '555', text: 'hi' });
    expect(add).toHaveBeenCalledWith(
      'send',
      { chatId: '555', text: 'hi' },
      { jobId: id, priority: TG_OUTBOX_PRIORITY.normal },
    );
  });

  it('every job carries a priority: normal by default, critical on request and for an owner code', async () => {
    const { add, enqueuer } = setup();
    await enqueuer.enqueue('alert-x-1-555', { chatId: '555', text: 'a' }, 'critical');
    await enqueuer.enqueueEphemeral('owner_otp-1', { chatId: '555', text: 'b' });
    expect(add).toHaveBeenNthCalledWith(1, 'send', expect.anything(), {
      jobId: 'alert-x-1-555',
      priority: TG_OUTBOX_PRIORITY.critical,
    });
    expect(add).toHaveBeenNthCalledWith(2, 'send', expect.anything(), {
      jobId: 'owner_otp-1',
      priority: TG_OUTBOX_PRIORITY.critical,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('rejects an invalid job before touching the queue', async () => {
    const { add, enqueuer } = setup();
    await expect(
      enqueuer.enqueue('order-abc-delivered', { chatId: 'not-digits', text: 'hi' }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
