# 07 — Telegram bot (o‘zbek va rus tillarida)

Bot — kirish eshigi va xabarnoma kanali. Xarid Mini App'da bo‘ladi; bot hech qachon pul mantiqini o‘zi bajarmaydi.

## Tilni aniqlash

1. Foydalanuvchi tanlagan til (`User.locale`) bo‘lsa — o‘sha.
2. Aks holda Telegram `language_code`: `ru`, `be`, `uk`, `kk` → **ru**, qolganlari → **uz**.
3. Birinchi `/start`da til tanlash xabari:
   `🇺🇿 O‘zbekcha` · `🇷🇺 Русский` (har doim ikkala tilda yozilgan).
Til Mini App va web bilan sinxron (bitta `User.locale`).

## /start

Payload'lar:
| Payload | Natija |
|---|---|
| — | salomlashish xabari |
| `ref_<code>` | referal bog‘lanadi (faqat birinchi marta, o‘zini taklif qilish mumkin emas) + salomlashish |
| `p_<slug>` | mahsulotni Mini App'da ochish tugmasi |
| `login_<nonce>` | web kirish: telefon ulashish (yangi foydalanuvchi bo‘lsa) → 6 xonali kod |
| `admin_<nonce>` | admin kirish (faqat allowlist); boshqalarga oddiy "havola eskirgan" |

Salomlashish xabari (rasm/banner + matn):
- uz: "👋 Xush kelibsiz, {name}! Telegram Stars, Premium va o‘yin donatlari — tez, xavfsiz va qulay narxda."
- ru: "👋 Добро пожаловать, {name}! Telegram Stars, Premium и донат в игры — быстро, безопасно и выгодно."
Tugmalar: `🛍 Xaridni boshlash` (web_app), `📢 Yangiliklar` (kanal), `💬 Yordam`, `🌐 Til`.

## Menyu tugmasi va buyruqlar

- Menu button: Mini App (`setChatMenuButton`, web_app), matni tilga qarab.
- `setMyCommands` (uz va ru alohida): `/start`, `/shop` (do‘kon), `/balance` (balans),
  `/orders` (oxirgi buyurtmalar), `/ref` (referal havola), `/lang` (til), `/help`.
- Admin buyruqlari faqat allowlist chatlarida (`scope: chat`): `/admin` (panelni Mini App'da ochish),
  `/stats` (bugungi qisqa statistika), `/wallet` (hot wallet holati), `/id`.

## Bildirishnomalar (outbox orqali)

| Hodisa | Xabar (uz) |
|---|---|
| Balans to‘ldirildi | "✅ Hisobingiz {amount} ga to‘ldirildi. Balans: {balance}" |
| Buyurtma qabul qilindi | "🧾 #{number} buyurtma qabul qilindi: {product} → {recipient}" |
| Yetkazildi | "🎉 #{number} yetkazildi! {product} → {recipient}" (+ "Buyurtmani ko‘rish" tugmasi) |
| Voucher | "🎟 #{number}: kodingiz Mini App'da" (kod chatga yuborilmaydi — faqat ilovada) |
| Muvaffaqiyatsiz | "⚠️ #{number} bajarilmadi. {amount} balansingizga qaytarildi." |
| Tekshirilmoqda | "⏳ #{number} tekshirilmoqda. Odatda 15 daqiqagacha. Pul xavfsiz." |
| Referal bonus | "🎁 Do‘stingiz xarid qildi — sizga {amount} bonus!" |
| Bonus kod | "🎁 Bonus kod faollashtirildi: +{amount}" |

Ruscha matnlar `ru.json`da. Xabarlar HTML parse mode, foydalanuvchi matnlari escape qilinadi.

## Rassilka (broadcast)

- Admin paneldan: uz va ru matnlari, rasm (ixtiyoriy), tugma, auditoriya (hammasi / til / oxirgi N kun faol /
  xarid qilganlar).
- Har bir foydalanuvchiga o‘z tilida; 25 xabar/s; botni bloklaganlar `isBlocked=true` (botni) belgilanadi.
- Hisobot: yuborildi / xato / bloklangan.

## Yordam (support)

- `💬 Yordam` → FAQ (Mini App) + "Operatorga yozish": foydalanuvchi xabari support guruhiga
  (topic = foydalanuvchi) forward qilinadi, operator javobi bot orqali qaytadi. Buyurtma raqami
  avtomatik ilova qilinadi. (MVP'da oddiyroq variant: operator akkaunti havolasi — D-07.)

## Texnik

- Prod: webhook + `secret_token`; dev: long polling.
- Rate limit: global ~30 xabar/s, bitta chatga 1 xabar/s; 429 → `retry_after`.
- Har handler uchun uz va ru snapshot test.
