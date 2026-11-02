// Parser for the bot `/start <payload>` deep link (docs/07-BOT.md). Telegram limits the
// parameter to 64 chars of [A-Za-z0-9_-]; anything that does not fit a known shape is `none`,
// so a hand-crafted payload can never reach a handler as something unexpected.

// 8 lowercase alphanumerics: the referral code generator (users module) must produce this.
export const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE = new RegExp(`^ref_([a-z0-9]{${REFERRAL_CODE_LENGTH}})$`);

// 32 random bytes, base64url without padding = 43 chars.
export const LOGIN_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN = /^login_([A-Za-z0-9_-]{43})$/;
const ADMIN = /^admin_([A-Za-z0-9_-]{43})$/;

// Kebab-case catalog slug; "p_" + 62 = Telegram's 64-char cap.
const PRODUCT = /^p_([a-z0-9][a-z0-9-]{0,61})$/;

export const START_PAYLOAD_MAX_LENGTH = 64;

export type StartPayload =
  | { readonly kind: 'none' }
  | { readonly kind: 'ref'; readonly code: string }
  | { readonly kind: 'login'; readonly nonce: string }
  | { readonly kind: 'admin'; readonly nonce: string }
  | { readonly kind: 'product'; readonly slug: string };

const NONE: StartPayload = { kind: 'none' };

export function parseStartPayload(payload: string | undefined): StartPayload {
  if (payload === undefined || payload.length > START_PAYLOAD_MAX_LENGTH) return NONE;

  const ref = REFERRAL_CODE.exec(payload)?.[1];
  if (ref !== undefined) return { kind: 'ref', code: ref };
  const login = LOGIN.exec(payload)?.[1];
  if (login !== undefined) return { kind: 'login', nonce: login };
  const admin = ADMIN.exec(payload)?.[1];
  if (admin !== undefined) return { kind: 'admin', nonce: admin };
  const slug = PRODUCT.exec(payload)?.[1];
  if (slug !== undefined) return { kind: 'product', slug };
  return NONE;
}
