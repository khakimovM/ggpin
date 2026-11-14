import { NOTIFY_JOB_NAME, notifyJobSchema } from '@repo/shared';
import type { Queue } from 'bullmq';
import { OrderNotifyProducer } from '../order-notify.producer';

function setup() {
  const add = jest.fn().mockResolvedValue(undefined);
  return { add, producer: new OrderNotifyProducer({ add } as unknown as Queue) };
}

describe('OrderNotifyProducer', () => {
  it('adds ORDER_ACCEPTED with the order id only, under the dedupe id order-<id>-accepted', async () => {
    const { add, producer } = setup();
    await producer.enqueue('ORDER_ACCEPTED', 'cm0order1');
    expect(add).toHaveBeenCalledWith(
      NOTIFY_JOB_NAME,
      { kind: 'ORDER_ACCEPTED', refId: 'cm0order1' },
      { jobId: 'order-cm0order1-accepted' },
    );
    const [, data] = add.mock.calls[0] as [string, unknown];
    expect(notifyJobSchema.parse(data)).toEqual(data);
  });

  it('refuses an id that cannot be a job id segment, before touching the queue', async () => {
    const { add, producer } = setup();
    await expect(producer.enqueue('ORDER_ACCEPTED', 'bad-id')).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it('a queue failure reaches the caller (who decides it is best effort)', async () => {
    const { add, producer } = setup();
    add.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(producer.enqueue('ORDER_ACCEPTED', 'cm0order1')).rejects.toThrow('closed');
  });
});
