---
name: grammy-bot-i18n
description: Build or change Telegram bot features with grammY in two languages (uz/ru) — commands, menus, deep links (ref_, product_), Mini App buttons, order and payment notifications, admin commands, broadcasts with rate limits. Use for any bot change.
---

# grammY bot (uz/ru)

- One `Bot` instance in `apps/api/src/infra/telegram`; handlers in `modules/telegram/handlers`.
- Middleware order: logging (redacted) → user upsert (telegramId, username, language_code) →
  locale resolve (`user.locale ?? (language_code startsWith 'ru' ? 'ru' : 'uz')`) → handlers.
- `ctx.t(key, params)` from `packages/i18n`; parse mode HTML with escaping helper.
- `/start [payload]`: payload `ref_<code>` (referral), `p_<slug>` (open product), `login_<nonce>`
  (web OTP), `admin_<nonce>` (admin OTP). First run → language picker (🇺🇿 O‘zbekcha / 🇷🇺 Русский).
- Menu button = Mini App (`setChatMenuButton` web_app). Main message has inline buttons:
  "🛍 Xaridni boshlash" (web_app), "📢 Yangiliklar", "💬 Yordam", "🌐 Til".
- Notifications are enqueued to `tg-outbox` (BullMQ), throttled, retried on 429 with `retry_after`.
- Commands set per language with `setMyCommands({ language_code })`; admin commands with
  `scope: chat` for allowlisted IDs only.
- Every handler has a uz and ru snapshot test of its output.
