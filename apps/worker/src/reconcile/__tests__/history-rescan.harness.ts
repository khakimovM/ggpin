import type { BankFeedSource } from '@repo/shared';
import type { BankFeedNotifier } from '../../bank-feed/bank-feed-notifier';
import type { BankFeedClient, BankFeedMessage } from '../../bank-feed/client/bank-feed-client';
import type { IngestResult, IngestService } from '../../bank-feed/client/ingest.service';
import { HistoryRescanService } from '../history-rescan.service';
import type { ReconcileRepository } from '../reconcile.repository';

// The HistoryRescanService test harness (history-rescan*.spec.ts): in-memory fakes for the
// client, the ingest path, the repository and the notifier.
export const SINCE = new Date('2030-05-01T00:00:00.000Z');
export const NOW = new Date('2030-05-03T00:00:00.000Z');
/** An ordinary history message: an hour old, well past the "listener's" bound. */
export const HOUR_AGO = new Date(NOW.getTime() - 3_600_000);
export const BOTS: Record<BankFeedSource, bigint | null> = {
  HUMO_BOT: 900_000_001n,
  UZCARD_BOT: 900_000_002n,
};

export function message(
  id: number,
  source: BankFeedSource = 'HUMO_BOT',
  date = HOUR_AGO,
): BankFeedMessage {
  const bot = BOTS[source] ?? 0n;
  return {
    id: BigInt(id),
    date,
    chatId: bot,
    senderId: bot,
    senderIsBot: true,
    text: 'synthetic',
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
  };
}

export function setup(
  client: BankFeedClient | null,
  opts: { known?: bigint[]; pins?: typeof BOTS; leading?: boolean | (() => boolean) } = {},
) {
  const pins = opts.pins ?? BOTS;
  const known = new Set(opts.known ?? []);
  const ingested: { source: BankFeedSource; id: bigint }[] = [];
  const ingest: Pick<IngestService, 'pinnedBot' | 'ingest'> = {
    pinnedBot: (source) => pins[source],
    ingest: (source, m): Promise<IngestResult> => {
      ingested.push({ source, id: m.id });
      return Promise.resolve({ stored: true, bankMessageId: `cm3rec${String(m.id)}` });
    },
  };
  const repo: Pick<ReconcileRepository, 'lastIdBefore' | 'knownIds'> = {
    lastIdBefore: (source) => Promise.resolve(source === 'HUMO_BOT' ? 100n : null),
    knownIds: (_source, ids) => Promise.resolve(new Set(ids.filter((id) => known.has(id)))),
  };
  const alert = jest
    .fn<Promise<void>, Parameters<BankFeedNotifier['alert']>>()
    .mockResolvedValue(undefined);
  const notifier: Pick<BankFeedNotifier, 'alert'> = { alert };
  const service = new HistoryRescanService(
    client,
    ingest as IngestService,
    repo as ReconcileRepository,
    notifier as BankFeedNotifier,
    opts.leading === undefined
      ? null
      : {
          mayRead: typeof opts.leading === 'function' ? opts.leading : () => opts.leading === true,
        },
  );
  const logError = jest.fn<void, [string]>();
  const logWarn = jest.fn<void, [string]>();
  service['logger'].warn = logWarn;
  service['logger'].error = logError;
  return { service, ingested, logError, logWarn, alert };
}
