# Security rules (always active)

## Identity
- Mini App: validate `initData` server-side (HMAC-SHA256, key = HMAC("WebAppData", botToken));
  reject if `auth_date` older than 24h for login, issue our own short session token.
- Web: Telegram OTP login (bot sends a 6-digit code), 3-minute expiry, 5 attempts, one-time,
  rate-limited; access token 15 min + refresh 30 days, rotated, hashed in DB, reuse → revoke family.
- Admin: separate login (`/admin`), allowlist `ADMIN_TELEGRAM_IDS` + role from `AdminUser`
  table (OWNER/OPERATOR/SUPPORT); session 8h absolute, 1h idle; re-check allowlist each request.

## Authorisation
- User resources: owner-scoped in repositories; others' → 404.
- Admin: role checks per route; every mutating admin action writes `AuditLog`
  (who, what, before/after, reason, ip) in the same transaction.
- Money-moving admin actions (refund, adjustment, manual deliver) require OWNER, a reason,
  and amounts above `ADMIN_CONFIRM_THRESHOLD_TIYIN` need a fresh OTP confirmation.

## Input / output
- Zod everywhere, `.strict()` on writes, `limit` ≤ 100.
- Escape user-controlled text in bot HTML messages; never `dangerouslySetInnerHTML` with user data.
- Helmet + strict CSP; CORS allowlist; cookies `httpOnly`, `secure`, `sameSite=lax`
  (admin `strict`); CSRF header check on state-changing routes.

## Secrets
- Never in git. `.env.example` placeholders only. Worker-only secrets (TON mnemonic,
  Fragment cookies, supplier keys) are rejected at API boot if present.
- Never log secrets, initData, OTP codes, full phone numbers, provider signatures.
- TON mnemonic: encrypted at rest (KMS or `WALLET_ENC_KEY` + AES-256-GCM), decrypted in
  memory only in the worker.

## Abuse
- Referral: no self-referral, one inviter per user, bonus only after DELIVERED, cap per day.
- Bonus/discount codes: rate-limited redemption, single-use per user, constant-time compare.
- Order creation: per-user rate limit and per-user daily spend cap for new accounts.
