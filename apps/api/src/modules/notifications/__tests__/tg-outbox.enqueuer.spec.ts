import { tgOutboxJobId } from '@repo/shared';
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
    expect(add).toHaveBeenCalledWith('send', { chatId: '555', text: 'hi' }, { jobId: id });
  });

  it('rejects an invalid job before touching the queue', async () => {
    const { add, enqueuer } = setup();
    await expect(
      enqueuer.enqueue('order-abc-delivered', { chatId: 'not-digits', text: 'hi' }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
