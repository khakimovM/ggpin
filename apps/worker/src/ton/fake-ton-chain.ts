import {
  Cell,
  Dictionary,
  beginCell,
  domainSignVerify,
  loadMessage,
  loadOutList,
  loadTransaction,
  storeMessage,
  storeTransaction,
  type Address,
  type DictionaryValue,
  type Message,
  type MessageRelaxed,
  type Transaction,
  type TransactionDescriptionGeneric,
} from '@ton/core';

// Builders of REAL @ton/core transactions for the fake chain (dev dry run and tests). Every
// transaction is serialized with `storeTransaction` and read back with `loadTransaction`, so the
// classifier sees exactly what it would get from toncenter's BOCs: real cells, real hashes. The
// numbers (fees, sizes) are plausible placeholders, not recorded values.

const OP_SIGNED_EXTERNAL = 0x7369676e;
const SIGNATURE_BITS = 512;
export const FAKE_TX_FEE_NANO = 2_000_000n;
export const FAKE_FWD_FEE_NANO = 400_000n;

const MESSAGE_VALUE: DictionaryValue<Message> = {
  serialize: (message, builder) => {
    builder.storeRef(beginCell().store(storeMessage(message)));
  },
  parse: (slice) => loadMessage(slice.loadRef().beginParse()),
};

export interface ParsedW5Request {
  readonly validSignature: boolean;
  readonly op: number;
  readonly walletId: number;
  readonly validUntil: number;
  readonly seqno: number;
  readonly messages: readonly { readonly mode: number; readonly message: MessageRelaxed }[];
}

/** Reads a W5R1 signed request (`createWalletTransferV5R1` layout) and checks its signature. */
export function parseW5Request(body: Cell, publicKey: Buffer): ParsedW5Request | null {
  try {
    const slice = body.beginParse();
    const signingBits = slice.remainingBits - SIGNATURE_BITS;
    if (signingBits < 0) return null;
    const signing = beginCell().storeBits(slice.loadBits(signingBits));
    const signature = slice.loadBuffer(SIGNATURE_BITS / 8);
    for (const ref of body.refs) signing.storeRef(ref);
    const signingCell = signing.endCell();
    const fields = signingCell.beginParse();
    const op = fields.loadUint(32);
    const walletId = fields.loadInt(32);
    const validUntil = fields.loadUint(32);
    const seqno = fields.loadUint(32);
    const outList = fields.loadMaybeRef();
    const actions = outList === null ? [] : loadOutList(outList.beginParse());
    const messages = actions.flatMap((a) =>
      a.type === 'sendMsg' ? [{ mode: a.mode, message: a.outMsg }] : [],
    );
    const validSignature = domainSignVerify({ data: signingCell.hash(), signature, publicKey });
    return { validSignature, op, walletId, validUntil, seqno, messages };
  } catch {
    return null;
  }
}

export function isSignedExternal(request: ParsedW5Request): boolean {
  return request.op === OP_SIGNED_EXTERNAL;
}

export function accountId(address: Address): bigint {
  return BigInt(`0x${address.hash.toString('hex')}`);
}

function hashBuffer(seed: string): Buffer {
  return beginCell().storeStringTail(seed).endCell().hash();
}

interface TxShape {
  readonly account: Address;
  readonly lt: bigint;
  readonly now: number;
  readonly prev: Transaction | null;
  readonly inMessage: Message;
  readonly outMessages: readonly Message[];
  readonly fee: bigint;
  readonly description: TransactionDescriptionGeneric;
  readonly deploy?: boolean;
}

/** Serializes and reads back: the result has the real `raw` cell and `hash()`. */
export function buildTx(shape: TxShape): Transaction {
  const outMessages = Dictionary.empty(Dictionary.Keys.Uint(15), MESSAGE_VALUE);
  shape.outMessages.forEach((message, index) => outMessages.set(index, message));
  const draft: Transaction = {
    address: accountId(shape.account),
    lt: shape.lt,
    prevTransactionHash:
      shape.prev === null ? 0n : BigInt(`0x${shape.prev.hash().toString('hex')}`),
    prevTransactionLt: shape.prev?.lt ?? 0n,
    now: shape.now,
    outMessagesCount: shape.outMessages.length,
    oldStatus: shape.deploy === true ? 'uninitialized' : 'active',
    endStatus: 'active',
    inMessage: shape.inMessage,
    outMessages,
    totalFees: { coins: shape.fee },
    stateUpdate: { oldHash: hashBuffer(`old-${shape.lt}`), newHash: hashBuffer(`new-${shape.lt}`) },
    description: shape.description,
    raw: Cell.EMPTY,
    hash: () => Buffer.alloc(32),
  };
  return loadTransaction(beginCell().store(storeTransaction(draft)).endCell().beginParse());
}

export interface PhaseOptions {
  readonly computeOk?: boolean;
  readonly totalActions?: number;
  readonly skippedActions?: number;
  readonly aborted?: boolean;
  readonly bounce?: 'ok' | 'no-funds' | null;
}

/** A generic description with a VM compute phase and (when it ran) an action phase. */
export function genericDescription(options: PhaseOptions = {}): TransactionDescriptionGeneric {
  const computeOk = options.computeOk ?? true;
  const totalActions = options.totalActions ?? 0;
  const skipped = options.skippedActions ?? 0;
  const size = { cells: 1n, bits: 700n };
  return {
    type: 'generic',
    creditFirst: true,
    storagePhase: { storageFeesCollected: 0n, statusChange: 'unchanged' },
    computePhase: {
      type: 'vm',
      success: computeOk,
      messageStateUsed: false,
      accountActivated: false,
      gasFees: FAKE_TX_FEE_NANO,
      gasUsed: 4_000n,
      gasLimit: 1_000_000n,
      mode: 0,
      exitCode: computeOk ? 0 : 35,
      vmSteps: 100,
      vmInitStateHash: 0n,
      vmFinalStateHash: 0n,
    },
    actionPhase: computeOk
      ? {
          success: true,
          valid: true,
          noFunds: false,
          statusChange: 'unchanged',
          totalFwdFees: FAKE_FWD_FEE_NANO,
          totalActionFees: FAKE_FWD_FEE_NANO / 2n,
          resultCode: 0,
          totalActions,
          specActions: 0,
          skippedActions: skipped,
          messagesCreated: totalActions - skipped,
          actionListHash: 0n,
          totalMessageSize: size,
        }
      : null,
    bouncePhase:
      options.bounce === 'ok'
        ? {
            type: 'ok',
            messageSize: size,
            messageFees: FAKE_FWD_FEE_NANO,
            forwardFees: FAKE_FWD_FEE_NANO,
          }
        : options.bounce === 'no-funds'
          ? { type: 'no-funds', messageSize: size, requiredForwardFees: FAKE_FWD_FEE_NANO }
          : null,
    aborted: options.aborted ?? false,
    destroyed: false,
  };
}

/** The internal message an action sends, with the chain's fields filled in. */
export function sentInternal(
  relaxed: MessageRelaxed,
  src: Address,
  createdLt: bigint,
  createdAt: number,
): Message | null {
  const info = relaxed.info;
  if (info.type !== 'internal') return null;
  return {
    info: {
      type: 'internal',
      ihrDisabled: info.ihrDisabled,
      bounce: info.bounce,
      bounced: false,
      src,
      dest: info.dest,
      value: info.value,
      ihrFee: 0n,
      forwardFee: FAKE_FWD_FEE_NANO,
      createdLt,
      createdAt,
    },
    init: relaxed.init ?? null,
    body: relaxed.body,
  };
}

/** The bounce a destination sends back for `original` (the bounced flag set, `value` returned). */
export function bounceOf(
  original: Message,
  value: bigint,
  createdLt: bigint,
  createdAt: number,
): Message {
  if (original.info.type !== 'internal') throw new Error('only an internal message bounces');
  return {
    info: {
      type: 'internal',
      ihrDisabled: true,
      bounce: false,
      bounced: true,
      src: original.info.dest,
      dest: original.info.src,
      value: { coins: value },
      ihrFee: 0n,
      forwardFee: FAKE_FWD_FEE_NANO,
      createdLt,
      createdAt,
    },
    init: null,
    body: beginCell().storeUint(0xffffffff, 32).endCell(),
  };
}
