import type { TonTransferStatus } from '@repo/db';
import { coversPayout, parseMajor, type TonLimits } from '@repo/shared';
import { beginCell, type Address, type Cell } from '@ton/core';
import type { WorkerConfig } from '../config/config.module';
import { rawAddress } from './ton-address';
import type { TonConfirmService } from './ton-confirm.service';
import { errorKind } from './ton-db-errors';
import type { TonGateway } from './ton-gateway';
import type { TonWalletLock } from './ton-lock';
import type { TonNetwork } from './ton-mnemonic';
import type { TonTransferRepository } from './ton-transfer.repository';
import { seqnoOf, w5ViewOf } from './ton-w5';
import { walletContractFor, type TonWallet } from './ton-wallet';

// The testnet self-test (plan S5 CLI, S12 step 1). It proves on the real testnet what the module
// takes from the W5 documentation, with value that never leaves our own key:
//  A. a signed message broadcast only AFTER its valid_until is not accepted: the transfer ends
//     EXPIRED (seqno unchanged, message not found) - the "provably not sent" proof of plan 6.5;
//  B. 0.01 TON to our own second wallet (subwallet 1, deployed on arrival, non-bounceable) is found
//     by its normalized external hash and ends CONFIRMED, with the seqno moved by exactly one.
// Both are SELFTEST rows of TonTransfer (no order) under the wallet lock and the same database
// fence as a payout. If A is not proven the EXPIRED proof must be switched off (plan 6.5), so B
// does not run. Mainnet is refused here as well as in the CLI.

export const SELFTEST_AMOUNT_NANO = parseMajor('TON', '0.01');
export const SELFTEST_SUBWALLET = 1;
/** Step A broadcasts this many chain seconds after valid_until. */
export const SELFTEST_LATE_SEC = 5;
const POLL_MS = 3_000;

export type SelftestConfig = Pick<WorkerConfig, 'NODE_ENV' | 'TON_NETWORK' | 'FULFILLMENT_DRY_RUN'>;

/** Why the self-test must not run with this config, or null. */
export function selftestRefusal(config: SelftestConfig): string | null {
  if (config.TON_NETWORK !== 'testnet') return 'TON_NETWORK must be testnet: mainnet is refused';
  if (config.FULFILLMENT_DRY_RUN) return 'FULFILLMENT_DRY_RUN must be false (a real testnet run)';
  if (config.NODE_ENV === 'production') return 'a testnet tool: NODE_ENV=production is refused';
  return null;
}

export interface SelftestDeps {
  readonly network: TonNetwork;
  readonly wallet: TonWallet;
  readonly gateway: TonGateway;
  readonly transfers: Pick<TonTransferRepository, 'signAndStore' | 'markBroadcast'>;
  readonly confirm: Pick<TonConfirmService, 'awaitOutcome'>;
  readonly lock: Pick<TonWalletLock, 'acquire'>;
  readonly limits: TonLimits;
  readonly feeReserveNano: bigint;
  readonly validSec: number;
  /** The database-vs-chain clock bound inside the signing transaction (`signLagMaxSec`). */
  readonly maxSignLagSec: number;
  readonly say: (line: string) => void;
  /** The pause between chain looks while step A's message expires. */
  readonly sleep: (ms: number) => Promise<void>;
}

export type SelftestStep = 'EXPIRED_PROOF' | 'TRANSFER';

export interface SelftestStepResult {
  readonly step: SelftestStep;
  readonly ok: boolean;
  readonly transferId: string | null;
  readonly status: TonTransferStatus | null;
  readonly note: string;
}

export interface SelftestReport {
  readonly ok: boolean;
  readonly steps: readonly SelftestStepResult[];
}

export class SelftestRefusedError extends Error {
  constructor(reason: string) {
    super(`ton self-test refused: ${reason}`);
    this.name = 'SelftestRefusedError';
  }
}

interface Signed {
  readonly transferId: string;
  readonly boc: Buffer;
  readonly seqno: number;
  readonly validUntilSec: number;
}

const failed = (step: SelftestStep, note: string): SelftestStepResult => ({
  step,
  ok: false,
  transferId: null,
  status: null,
  note,
});

function selftestBody(): Cell {
  return beginCell().storeUint(0, 32).storeStringTail('self-test').endCell();
}

async function signStored(
  deps: SelftestDeps,
  step: SelftestStep,
): Promise<Signed | SelftestStepResult> {
  const { wallet, network } = deps;
  const state = await deps.gateway.getAccountState(wallet.address);
  const view = w5ViewOf(state, wallet.own);
  if (!view.ready) return failed(step, `the wallet is not usable (${view.why})`);
  if (!coversPayout(state.balanceNano, SELFTEST_AMOUNT_NANO, deps.feeReserveNano)) {
    return failed(step, 'the wallet balance does not cover 0.01 TON plus TON_FEE_RESERVE_NANO');
  }
  const destination = walletContractFor(wallet.own.publicKey, network, SELFTEST_SUBWALLET);
  const to: Address = destination.address;
  const validUntilSec = state.chainTime + deps.validSec;
  const stored = await deps.transfers.signAndStore({
    order: null,
    network,
    walletAddress: wallet.rawAddress,
    toAddress: rawAddress(to),
    amountNano: SELFTEST_AMOUNT_NANO,
    seqno: view.seqno,
    validUntilSec,
    limits: deps.limits,
    chainTimeSec: state.chainTime,
    maxSignLagSec: deps.maxSignLagSec,
    sign: () =>
      wallet.sign({
        seqno: view.seqno,
        validUntilSec,
        to,
        amountNano: SELFTEST_AMOUNT_NANO,
        body: selftestBody(),
        bounce: false,
        deploy: view.deploy,
        destinationInit: destination.init,
      }),
  });
  if (stored.kind !== 'STORED') return failed(step, `nothing was signed (${stored.kind})`);
  return {
    transferId: stored.transfer.id,
    boc: stored.signed.boc,
    seqno: view.seqno,
    validUntilSec,
  };
}

/** One sendBoc; true when the network took it. Nothing is ever sent twice. */
async function broadcastOnce(deps: SelftestDeps, signed: Signed): Promise<boolean> {
  try {
    await deps.gateway.sendBoc(signed.boc);
  } catch (error) {
    deps.say(`sendBoc refused or failed (${errorKind(error)})`);
    return false;
  }
  await deps.transfers.markBroadcast(signed.transferId, null);
  return true;
}

async function expiredProof(deps: SelftestDeps, keepAlive: () => Promise<unknown>) {
  const step: SelftestStep = 'EXPIRED_PROOF';
  const signed = await signStored(deps, step);
  if ('step' in signed) return signed;
  deps.say(`A: signed seqno ${String(signed.seqno)}; waiting for valid_until to pass`);
  for (;;) {
    const state = await deps.gateway.getAccountState(deps.wallet.address);
    if (state.chainTime > signed.validUntilSec + SELFTEST_LATE_SEC) break;
    await keepAlive();
    await deps.sleep(POLL_MS);
  }
  const taken = await broadcastOnce(deps, signed);
  const state = await deps.confirm.awaitOutcome(signed.transferId, keepAlive);
  const status = state?.transferStatus ?? null;
  const ok = status === 'EXPIRED';
  const sent = taken ? 'taken by sendBoc' : 'refused by sendBoc';
  return {
    step,
    ok,
    transferId: signed.transferId,
    status,
    note: ok
      ? `the late message (${sent}) was never accepted: EXPIRED is proven`
      : `NOT PROVEN (status ${String(status)}): switch the EXPIRED proof off (plan 6.5)`,
  };
}

async function transferStep(deps: SelftestDeps, keepAlive: () => Promise<unknown>) {
  const step: SelftestStep = 'TRANSFER';
  const signed = await signStored(deps, step);
  if ('step' in signed) return signed;
  deps.say(`B: signed seqno ${String(signed.seqno)}: 0.01 TON to our subwallet 1`);
  await broadcastOnce(deps, signed);
  const state = await deps.confirm.awaitOutcome(signed.transferId, keepAlive);
  const status = state?.transferStatus ?? null;
  const after = seqnoOf(await deps.gateway.getAccountState(deps.wallet.address), deps.wallet.own);
  const moved = after === signed.seqno + 1;
  const ok = status === 'CONFIRMED' && moved;
  return {
    step,
    ok,
    transferId: signed.transferId,
    status,
    note: ok
      ? 'found by its normalized hash, CONFIRMED, seqno moved by exactly one'
      : `NOT CONFIRMED (status ${String(status)}, seqno now ${String(after)})`,
  };
}

export async function runTonSelftest(deps: SelftestDeps): Promise<SelftestReport> {
  if (deps.network !== 'testnet') throw new SelftestRefusedError('testnet only');
  const lease = await deps.lock.acquire();
  if (lease === null) throw new SelftestRefusedError('another sender holds the TON wallet lock');
  const keepAlive = () => lease.renew();
  try {
    const a = await expiredProof(deps, keepAlive);
    deps.say(`A ${a.ok ? 'PASS' : 'FAIL'}: ${a.note}`);
    if (!a.ok) return { ok: false, steps: [a] };
    const b = await transferStep(deps, keepAlive);
    deps.say(`B ${b.ok ? 'PASS' : 'FAIL'}: ${b.note}`);
    return { ok: b.ok, steps: [a, b] };
  } finally {
    await lease.release();
  }
}
