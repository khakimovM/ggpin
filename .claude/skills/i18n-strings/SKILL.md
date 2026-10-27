---
name: i18n-strings
description: Add or change user-facing text in Uzbek and Russian — message keys, ICU plurals, apostrophe rules, bot messages, error messages, SEO metadata. Use whenever any user-visible string is added or edited.
---

# i18n (uz + ru)

1. Add the key to `packages/i18n/uz.json` AND `packages/i18n/ru.json` in the same change.
2. Uzbek Latin: o‘ g‘ with U+2018, tutuq belgisi ʼ (U+02BC). Short, plain, friendly; "siz" form.
3. Russian: neutral-polite "вы"; plurals `one|few|many|other`.
4. Money via `formatMoney` ("12 550 so‘m" / "12 550 сум"); dates via Intl with locale.
5. Brand/product names are not translated.
6. Run the key-parity test (`npm test -w packages/i18n`).
7. For SEO pages add `meta.<page>.title/description` in both languages.
