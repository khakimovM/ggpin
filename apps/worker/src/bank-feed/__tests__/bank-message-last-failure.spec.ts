import type { BankFeedEffects } from '../bank-feed-effects';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import type { BankMessageRepository } from '../bank-message.repository';
import { BankMessageProcessor, type BankMessageJob } from '../bank-message.processor';
import { FailClosedService } from '../fail-closed.service';
import type { MatchWritesRepository } from '../match-writes.repository';
import type { MatcherService } from '../matcher.service';
import type { TopupCardsRepository } from '../topup-cards.repository';

// S9F-I1: the owner alert after a message's LAST failed attempt says what will happen next.
// No decision stored → `messageStuck` (the orphan re-queue retries it later). Decision stored,
// only the post-commit effects failed → `effectsFailed` (the re-queue takes only undecided
// messages, so it is never re-run). Collaborators are plain fakes: no Redis or DB.
const ID = 'cm3bankmsg0000000000002';

function setup(close: jest.Mock<ReturnType<FailClosedService['close']>, [string]>) {
  const failure = Object.assign(new Error('synthetic'), { name: 'SyntheticEffectsError' });
  const process = jest.fn<Promise<never>, [string, boolean]>().mockRejectedValue(failure);
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
  return { processor, alert, failure };
}

function lastAttempt() {
  return {
    id: `bm-${ID}`,
    data: { bankMessageId: ID } satisfies BankMessageJob,
    attemptsMade: 4,
    opts: { attempts: 5 },
    updateData: jest.fn<Promise<void>, [BankMessageJob]>().mockResolvedValue(undefined),
    moveToDelayed: jest
      .fn<Promise<void>, [number, string | undefined]>()
      .mockResolvedValue(undefined),
  };
}

const closing = (result: Awaited<ReturnType<FailClosedService['close']>>) =>
  jest.fn<ReturnType<FailClosedService['close']>, [string]>().mockResolvedValue(result);

describe('BankMessageProcessor: the alert after the last attempt (S9F-I1)', () => {
  it('decision stored, effects failed: effectsFailed (not messageStuck); the job still fails', async () => {
    const { processor, alert, failure } = setup(closing('HAS_OUTCOME'));
    await expect(processor.process(lastAttempt(), 'tok')).rejects.toBe(failure);
    expect(alert.mock.calls).toEqual([['effectsFailed', ID]]);
  });

  it('no review could be written: fail-closed sent messageStuck itself, nothing more here', async () => {
    const { processor, alert, failure } = setup(closing('STUCK_ALERTED'));
    await expect(processor.process(lastAttempt(), 'tok')).rejects.toBe(failure);
    expect(alert).not.toHaveBeenCalled();
  });

  it('fail-closed itself threw: messageStuck (undecided, the re-queue retries it)', async () => {
    const close = jest
      .fn<ReturnType<FailClosedService['close']>, [string]>()
      .mockRejectedValue(new Error('synthetic close failure'));
    const { processor, alert, failure } = setup(close);
    await expect(processor.process(lastAttempt(), 'tok')).rejects.toBe(failure);
    expect(alert.mock.calls).toEqual([['messageStuck', ID]]);
  });

  it('failed closed (review written): no stuck alert, the job ends FAILED_CLOSED', async () => {
    const { processor, alert } = setup(closing('FAILED_CLOSED'));
    await expect(processor.process(lastAttempt(), 'tok')).resolves.toBe('FAILED_CLOSED');
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('BankMessageProcessor: effectsFailed edge cases (S9F-I1)', () => {
  it('a review written by fail-closed whose effects failed: effectsFailed too', async () => {
    const { processor, alert, failure } = setup(closing('EFFECTS_FAILED'));
    await expect(processor.process(lastAttempt(), 'tok')).rejects.toBe(failure);
    expect(alert.mock.calls).toEqual([['effectsFailed', ID]]);
  });

  it('the effectsFailed alert itself failing is logged; it never turns into messageStuck', async () => {
    const { processor, alert, failure } = setup(closing('HAS_OUTCOME'));
    alert.mockRejectedValue(new Error('synthetic redis down'));
    await expect(processor.process(lastAttempt(), 'tok')).rejects.toBe(failure);
    expect(alert.mock.calls).toEqual([['effectsFailed', ID]]);
  });
});

describe('FailClosedService: the review is written but its effects fail (S9F-I1)', () => {
  it('returns EFFECTS_FAILED (decided), never STUCK_ALERTED, and sends no messageStuck', async () => {
    const tx = {};
    const reads = {
      findMessage: jest.fn().mockResolvedValue({ id: ID, outcome: null, cardId: null }),
      hasOutcome: jest.fn().mockResolvedValue(false),
      client: { $transaction: (fn: (t: object) => Promise<boolean>) => fn(tx) },
    };
    const writes = { review: jest.fn().mockResolvedValue(undefined), pauseAutoCredit: jest.fn() };
    const cards = { setLockTimeout: jest.fn().mockResolvedValue(undefined), lockCard: jest.fn() };
    const effects = { run: jest.fn().mockRejectedValue(new Error('synthetic effects failure')) };
    const notifier = { alert: jest.fn().mockResolvedValue(undefined) };
    const service = new FailClosedService(
      reads as unknown as BankMessageRepository,
      writes as unknown as MatchWritesRepository,
      cards as unknown as TopupCardsRepository,
      effects as unknown as BankFeedEffects,
      notifier as unknown as BankFeedNotifier,
      { lockWaitMs: 1, tries: 3, pauseMs: 0 },
    );
    service['logger'].warn = jest.fn();
    await expect(service.close(ID)).resolves.toBe('EFFECTS_FAILED');
    expect(writes.review).toHaveBeenCalledTimes(1); // not tried again: the review is stored
    expect(notifier.alert).not.toHaveBeenCalled();
  });
});
