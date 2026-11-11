import { DelayedError } from 'bullmq';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import {
  BankMessageProcessor,
  DB_OUTAGE_WAIT_MS,
  MAX_DB_OUTAGE_WAITS,
  type BankMessageJob,
} from '../bank-message.processor';
import type { FailClosedService } from '../fail-closed.service';
import type { MatcherService } from '../matcher.service';

// N5 (S6 follow-up): an unreachable database waits instead of spending attempts and failing
// the message closed; a data error does not wait. Collaborators are plain fakes: no Redis or DB.
const ID = 'cm3bankmsg0000000000001';

function outage(code = 'P1001'): Error {
  return Object.assign(new Error('synthetic'), {
    name: 'PrismaClientKnownRequestError',
    code,
  });
}

function dataError(): Error {
  return Object.assign(new Error('synthetic'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
  });
}

function setup(error: Error) {
  const process = jest.fn<Promise<never>, [string, boolean]>().mockRejectedValue(error);
  const close = jest
    .fn<ReturnType<FailClosedService['close']>, [string]>()
    .mockResolvedValue('FAILED_CLOSED');
  const alert = jest
    .fn<Promise<void>, Parameters<BankFeedNotifier['alert']>>()
    .mockResolvedValue(undefined);
  const matcher: Pick<MatcherService, 'process'> = { process };
  const failClosed: Pick<FailClosedService, 'close'> = { close };
  const notifier: Pick<BankFeedNotifier, 'alert'> = { alert };
  const processor = new BankMessageProcessor(
    matcher as MatcherService,
    failClosed as FailClosedService,
    notifier as BankFeedNotifier,
  );
  processor['logger'].log = jest.fn();
  processor['logger'].warn = jest.fn();
  processor['logger'].error = jest.fn();
  return { processor, close };
}

function job(data: BankMessageJob, attemptsMade: number) {
  return {
    id: `bm-${ID}`,
    data,
    attemptsMade,
    opts: { attempts: 5 },
    updateData: jest.fn<Promise<void>, [BankMessageJob]>().mockResolvedValue(undefined),
    moveToDelayed: jest
      .fn<Promise<void>, [number, string | undefined]>()
      .mockResolvedValue(undefined),
  };
}

describe('BankMessageProcessor database outage window (N5)', () => {
  it.each(['P1001', 'P2028'])(
    'delays an outage (%s) without spending an attempt, even on the last attempt',
    async (code) => {
      const { processor, close } = setup(outage(code));
      const j = job({ bankMessageId: ID, dbOutageWaits: 3 }, 4);
      const before = Date.now();
      await expect(processor.process(j, 'tok')).rejects.toBeInstanceOf(DelayedError);
      expect(j.updateData).toHaveBeenCalledWith({ bankMessageId: ID, dbOutageWaits: 4 });
      const [until, token] = j.moveToDelayed.mock.calls[0] ?? [0, undefined];
      expect(until).toBeGreaterThanOrEqual(before + DB_OUTAGE_WAIT_MS);
      expect(token).toBe('tok');
      expect(close).not.toHaveBeenCalled();
    },
  );

  it('keeps the predecessor wait count apart from the outage count', async () => {
    const { processor } = setup(outage());
    const j = job({ bankMessageId: ID, predecessorWaits: 7 }, 0);
    await expect(processor.process(j, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(j.updateData).toHaveBeenCalledWith({
      bankMessageId: ID,
      predecessorWaits: 7,
      dbOutageWaits: 1,
    });
  });

  it('after the window an outage spends attempts and the last one fails closed', async () => {
    const { processor, close } = setup(outage());
    const early = job({ bankMessageId: ID, dbOutageWaits: MAX_DB_OUTAGE_WAITS }, 1);
    await expect(processor.process(early, 'tok')).rejects.toMatchObject({ code: 'P1001' });
    expect(early.moveToDelayed).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    const last = job({ bankMessageId: ID, dbOutageWaits: MAX_DB_OUTAGE_WAITS }, 4);
    await expect(processor.process(last, 'tok')).resolves.toBe('FAILED_CLOSED');
    expect(close).toHaveBeenCalledWith(ID);
  });

  it('a data error never waits: the last attempt fails closed at once', async () => {
    const { processor, close } = setup(dataError());
    const last = job({ bankMessageId: ID }, 4);
    await expect(processor.process(last, 'tok')).resolves.toBe('FAILED_CLOSED');
    expect(last.moveToDelayed).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(ID);
  });

  it('when the delay itself fails, the outage is handled as an ordinary failure', async () => {
    const { processor, close } = setup(outage());
    const last = job({ bankMessageId: ID }, 4);
    last.moveToDelayed.mockRejectedValue(new Error('redis down'));
    await expect(processor.process(last, 'tok')).resolves.toBe('FAILED_CLOSED');
    expect(close).toHaveBeenCalledWith(ID);
  });
});
