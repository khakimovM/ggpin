import type { SecretValue } from '../adapters/fragment/fixture-sanitizer';
import type { TonConnectInfo } from './fragment-record-inputs';
import {
  readFromAddress,
  readMessageCount,
  readPayAddresses,
  readPayloadInfo,
  type PayloadInfo,
} from './fragment-record-read';

// The payment link step, shared by Stars and Premium (plan S0b, P6-S0a): the request fields and
// what the recorder takes from the answer. The answer only DESCRIBES a transaction; nothing here
// (or anywhere in the tool) signs or sends one.

/** Fields of getBuyStarsLink / getGiftPremiumLink (guesses, docs/suppliers/fragment.md). */
export function linkFields(
  reqId: string,
  tonConnect: TonConnectInfo | null,
): Record<string, string> {
  const fields: Record<string, string> = { id: reqId, transaction: '1', show_sender: '0' };
  if (tonConnect !== null) {
    fields['account'] = tonConnect.accountJson;
    if (tonConnect.deviceJson !== null) fields['device'] = tonConnect.deviceJson;
  }
  return fields;
}

export interface LinkFacts {
  readonly payloads: PayloadInfo[];
  /** Fragment's pay address, or null when the answer does not hold exactly one message (R-4). */
  readonly payTo: string[] | null;
}

/** Reads a link answer; the sending wallet it names is pushed to `secrets` first (KEEP1). */
export function takeLink(body: string, secrets: SecretValue[]): LinkFacts {
  const payloads = readPayloadInfo(body);
  // The sending wallet named by the link is the owner's: never kept, even with a wrong --wallet.
  const from = readFromAddress(body);
  if (from !== null) secrets.push({ kind: 'address', value: from });
  // R-4: exactly one message (Fragment's pay address) is kept; anything else is not trusted.
  const payTo = readPayAddresses(body);
  if (payTo.length !== 1 || readMessageCount(body) !== 1) return { payloads, payTo: null };
  return { payloads, payTo };
}
