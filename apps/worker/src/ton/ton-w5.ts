import { Cell, beginCell } from '@ton/core';
import type { TonAccountState } from './ton-gateway';

// The persistent data of a W5R1 wallet, the layout @ton/ton writes into `WalletContractV5R1.init`
// (wallet-contract-v5, build 4fab977): signature_allowed:1 seqno:32 wallet_id:32 public_key:256
// extensions:dict. Reading the seqno from the data cell (instead of a get-method call) keeps it in
// the same snapshot as the chain time and the last transaction (plan 6.5). A unit test checks the
// layout against the library's own init data.

export interface W5Data {
  readonly signatureAllowed: boolean;
  readonly seqno: number;
  readonly walletId: number;
  readonly publicKey: Buffer;
}

export function parseW5Data(data: Cell): W5Data {
  const slice = data.beginParse();
  return {
    signatureAllowed: slice.loadBit(),
    seqno: slice.loadUint(32),
    walletId: slice.loadInt(32),
    publicKey: slice.loadBuffer(32),
  };
}

/** The data cell of a wallet at `seqno`, without extensions (the fake chain writes it). */
export function buildW5Data(base: W5Data, seqno: number): Cell {
  return beginCell()
    .storeBit(base.signatureAllowed)
    .storeUint(seqno, 32)
    .storeInt(base.walletId, 32)
    .storeBuffer(base.publicKey, 32)
    .storeBit(false)
    .endCell();
}

export type W5View =
  | { readonly ready: true; readonly seqno: number; readonly deploy: boolean }
  | {
      readonly ready: false;
      readonly why: 'FROZEN' | 'NO_DATA' | 'SIGNATURE_DISABLED' | 'FOREIGN_KEY' | 'FOREIGN_ID';
    };

/**
 * What the chain says about OUR wallet: an uninitialized account is deployed by the first message
 * (seqno 0); an active one must be ours (public key and wallet id of `own`, the init data the
 * mnemonic derives) and must accept signatures. Anything else: nothing is signed.
 */
export function w5ViewOf(state: TonAccountState, own: W5Data): W5View {
  if (state.status === 'frozen') return { ready: false, why: 'FROZEN' };
  if (state.status === 'uninitialized') return { ready: true, seqno: 0, deploy: true };
  if (state.data === null) return { ready: false, why: 'NO_DATA' };
  let data: W5Data;
  try {
    const cells = Cell.fromBoc(state.data);
    const first = cells[0];
    if (first === undefined) return { ready: false, why: 'NO_DATA' };
    data = parseW5Data(first);
  } catch {
    return { ready: false, why: 'NO_DATA' };
  }
  if (!data.publicKey.equals(own.publicKey)) return { ready: false, why: 'FOREIGN_KEY' };
  if (data.walletId !== own.walletId) return { ready: false, why: 'FOREIGN_ID' };
  if (!data.signatureAllowed) return { ready: false, why: 'SIGNATURE_DISABLED' };
  return { ready: true, seqno: data.seqno, deploy: false };
}

/** The seqno an account state shows for our wallet, or null when it cannot be read as ours. */
export function seqnoOf(state: TonAccountState, own: W5Data): number | null {
  const view = w5ViewOf(state, own);
  return view.ready ? view.seqno : null;
}
