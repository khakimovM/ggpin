// The reconciler's name for the worker's episode refIds. They live in common/episode-ref.ts since
// S9i (S9e audit N-3), shared with the fulfill settle; this file only keeps the reconciler's imports
// (one function, one format, whoever builds the id).
export {
  WALLET_BLOCKED_REMIND_EVERY_MS,
  episodeAlert,
  episodeRef,
  walletBlockedRef,
  type EpochScope,
  type GuardScope,
} from '../../common/episode-ref';
