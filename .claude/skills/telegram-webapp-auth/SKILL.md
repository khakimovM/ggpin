---
name: telegram-webapp-auth
description: Authenticate Telegram Mini App users with initData (server-side HMAC validation, freshness, session token issuance) and wire the Mini App client (theme, safe area, BackButton, MainButton, openLink). Use for Mini App auth or any /tg route.
---

# Telegram Mini App auth

## Server (apps/api/src/modules/auth/telegram-webapp)
```ts
// secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
// check  = HMAC_SHA256(key=secret, msg=data_check_string) === hash  (timingSafeEqual)
// data_check_string = all fields except `hash`, sorted by key, "key=value" joined by "\n"
```
- Reject if `auth_date` older than `TG_INITDATA_MAX_AGE_SEC` (default 86400).
- Upsert user from `user` JSON; read `start_param` (referral) once on first login only.
- Issue a short-lived session token (JWT 1h, refresh via re-sending initData); the Mini App keeps it
  in memory and sends `Authorization: Bearer`. No cookies in the Telegram webview (iframe on Telegram Web).
- Tests: valid, tampered field, wrong bot token, expired auth_date, replay across bots.

## Client (apps/web /tg)
`WebApp.ready()`, `expand()`, map `themeParams` → CSS vars, apply `safeAreaInset` /
`contentSafeAreaInset`, BackButton for nested routes, MainButton for "Sotib olish"/"To‘lash",
HapticFeedback on result, `openLink` for payment pages that must open externally.
