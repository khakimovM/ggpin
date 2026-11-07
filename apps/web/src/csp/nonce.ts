// Per-request CSP nonce. Pure and edge-safe (Web Crypto + btoa only), so the middleware, the
// server layouts and the unit tests share one definition.

/** 16 random bytes = 128 bits, the minimum the CSP spec recommends for a nonce. */
const NONCE_BYTES = 16;

/** Standard base64 of 16 bytes: 22 alphabet characters plus `==`. */
export const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The header the middleware uses to hand the nonce to server components of the same request. */
export const NONCE_HEADER = 'x-nonce';
