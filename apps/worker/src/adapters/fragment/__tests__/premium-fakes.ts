import { FAKE, OWNER_WALLET_RAW, form } from './fragment-fakes';

// Made-up Premium answers for the recorder tests (P6-S0a). Every value is fake; the SHAPES are the
// guesses of docs/suppliers/fragment.md §6 (Stars-like), not recordings.

const BOC_HEAD = Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x41, 0x01]);
const NUL4 = String.fromCharCode(0, 0, 0, 0);

/** Fragment's Premium pay address in these fakes: another account than the Stars one. */
export const PREMIUM_PAY_ADDRESS = form(0x2b, 'bounceable');

/** An account that already has Premium (Q10): a third person whose data must never be staged. */
export const HOLDER = {
  username: 'gift_holder_acc',
  name: 'Dilnoza Qosimova',
  recipient: `fakeHolder${'Opaque'}9876543210`,
  photoUrl: 'https://cdn4.telesco.pe/file/fakeHolderPic0000.jpg',
};

export const PREMIUM_REQ_ID = 'fakeReqPrem01';

/** Every holder value, and its parts, in the forms a leak could take. */
export function holderSecretForms(): string[] {
  return [
    HOLDER.username,
    HOLDER.name,
    'Dilnoza',
    'Qosimova',
    HOLDER.recipient,
    'fakeHolderPic0000',
  ];
}

/**
 * The holder found; its name and recipient are also echoed under keys no rule knows, so only
 * exact-value redaction can remove them.
 */
export function holderFoundResponse(): Record<string, unknown> {
  return {
    ok: true,
    found: {
      myself: false,
      recipient: HOLDER.recipient,
      name: HOLDER.name,
      photo: `<img src="${HOLDER.photoUrl}" alt="${HOLDER.name}">`,
    },
    note: `${HOLDER.name} (@${HOLDER.username}) already has Telegram Premium`,
    ref: `gift ${HOLDER.recipient}`,
  };
}

/** The holder refused, the name and username only in free text. */
export function holderErrorResponse(text = `${HOLDER.name} (@${HOLDER.username})`): unknown {
  return { ok: false, error: `${text} already has Telegram Premium`, premium: true };
}

export function premiumInitResponse(): Record<string, unknown> {
  return {
    req_id: PREMIUM_REQ_ID,
    myself: true,
    amount: '3.75',
    months: 3,
    item_title: 'Telegram Premium for 3 months',
  };
}

/** A BOC-like payload whose comment names the recipient (guessed, as for Stars). */
export function premiumPayload(): string {
  const comment = Buffer.from(
    `${NUL4}Telegram Premium for 3 months for @${FAKE.username}\n\nRef#${PREMIUM_REQ_ID}`,
  );
  return Buffer.concat([BOC_HEAD, comment]).toString('base64');
}

/** Short base64 that is NOT a BOC and names nobody: still always redacted under `payload`. */
export function plainPremiumPayload(): string {
  return Buffer.from('3 months gift').toString('base64');
}

export function premiumLinkResponse(payload: string = premiumPayload()): Record<string, unknown> {
  return {
    ok: true,
    transaction: {
      validUntil: 1_900_000_000,
      from: OWNER_WALLET_RAW,
      messages: [{ address: PREMIUM_PAY_ADDRESS, amount: '3750000000', payload }],
    },
  };
}
