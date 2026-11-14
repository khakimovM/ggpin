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

| Payload         | Natija                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| —               | salomlashish xabari                                                                                        |
| `ref_<code>`    | referal bog‘lanadi (faqat birinchi marta, o‘zini taklif qilish mumkin emas) + salomlashish                 |
| `p_<slug>`      | mahsulotni Mini App'da ochish tugmasi (mahsulot sahifalari tayyor bo‘lguncha oddiy `/start` kabi ishlaydi) |
| `login_<nonce>` | web kirish: telefon ulashish (yangi foydalanuvchi bo‘lsa) → 6 xonali kod                                   |
| `admin_<nonce>` | admin kirish (faqat allowlist); boshqalarga oddiy "havola eskirgan"                                        |

`login_<nonce>` oqimi (2-faza, D-27, D-29):

1. Havola tekshiriladi. Eskirgan yoki boshqa hisob olgan havolaga mos xabar chiqadi
   (`bot.login.expired` / `usedByOther`), telefon so‘ralmaydi.
2. `phone` bo‘sh bo‘lsa — «Raqamni ulashish» tugmasi (`request_contact`). Faqat o‘z kontakti
   qabul qilinadi (`contact.user_id = from.id`), boshqasi — `bot.login.contactNotYours`.
   Kutilayotgan havola Redis’da (`tg:login-contact:<telegramId>`, 10 daqiqa) turadi. Raqam
   faqat kod muvaffaqiyatli berilganda saqlanadi: havola eskirgan yoki boshqa hisobniki bo‘lsa,
   raqam saqlanmaydi.
3. Kod `<code>` ichida, `protect_content` bilan (forward qilib bo‘lmaydi) yuboriladi. Matnda:
   "kodni faqat ggpin.uz saytiga kiriting" va "hech kimga bermang" (brend va domen
   `packages/shared/src/brand.ts`dan). Kod faqat shu javobda bo‘ladi: logga ham, navbatga ham
   tushmaydi. Xabar yetkazilmasa, so‘rov `PENDING`ga qaytariladi va havolani qayta ochish mumkin.
4. Kod ostida «Bu men emasman» tugmasi (`ld:<nonce>`). Kod hali ishlatilmagan bo‘lsa, so‘rov
   `DENIED` bo‘ladi. Kod allaqachon saytga kiritilgan bo‘lsa, o‘sha web sessiya darhol yopiladi
   (`bot.login.sessionEnded`). Ikkala holda ham xabar tahrirlanadi va kod chatdan o‘chadi.
5. Takroriy `/start login_` (masalan, webhook ikki marta kelsa) ikkinchi kod bermaydi:
   `bot.login.alreadySent`. Bitta hisobga 10 daqiqada 5 tadan ortiq kod berilmaydi:
   `bot.login.rateLimited`.
6. Har bir muvaffaqiyatli web kirishdan keyin bot «yangi kirish» xabarini yuboradi
   (`tg-outbox` orqali). Unda qurilma, yashirilgan IP, Toshkent vaqti va «Bu men emasman»
   tugmasi (`se:<sessiya id>`) bor. Tugma o‘sha sessiyani yopadi, lekin faqat sessiya egasining
   akkauntida ishlaydi.

Xavfsizlik: shaxsiy chatdan kelgan update’da `chat.id ≠ from.id` bo‘lsa, update jimgina
tashlab yuboriladi. Haqiqiy Telegram update’ida ular doim teng bo‘ladi.

Salomlashish xabari (rasm/banner + matn):

- uz: "👋 Xush kelibsiz, {name}! Telegram Stars, Premium va o‘yin donatlari — tez, xavfsiz va qulay narxda."
- ru: "👋 Добро пожаловать, {name}! Telegram Stars, Premium и донат в игры — быстро, безопасно и выгодно."
  Tugmalar: `🛍 Xaridni boshlash` (web_app), `📢 Yangiliklar` (kanal), `💬 Yordam`, `🌐 Til`.

## Menyu tugmasi va buyruqlar

- Menu button: Mini App (`setChatMenuButton`, web_app), matni tilga qarab.
- `setMyCommands` (uz va ru alohida, D-28): `/start`, `/shop` (do‘kon), `/ref` (referal havola),
  `/lang` (til), `/help`. `/balance` va `/orders` qo‘shilmaydi (D-28): balans va
  buyurtmalar Mini App’da.
- Admin buyruqlari faqat allowlist chatlarida (`scope: chat`): `/admin` (panelni Mini App'da ochish),
  `/stats` (bugungi qisqa statistika), `/wallet` (hot wallet holati), `/id`.

## Bildirishnomalar (outbox orqali)

| Hodisa                 | Xabar (uz)                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Balans to‘ldirildi     | "✅ Hisobingiz to‘ldirildi: {amount}↵Balans: {balance}" (+ "➕ Hisobni to‘ldirish" tugmasi, Mini App `/topup`) |
| Kech tushgan to‘lov    | "✅ Kechikkan to‘lovingiz hisobga tushdi: {amount}↵Balans: {balance}" (+ o‘sha tugma)                          |
| Buyurtma qabul qilindi | "🧾 #{number} buyurtma qabul qilindi: {product} → {recipient}" (+ "Buyurtmani ko‘rish" tugmasi)                |
| Yetkazildi             | "🎉 #{number} yetkazildi! {product} → {recipient}" (+ "Buyurtmani ko‘rish" tugmasi)                            |
| Voucher                | "🎟 #{number}: kodingiz Mini App'da" (kod chatga yuborilmaydi — faqat ilovada)                                  |
| Muvaffaqiyatsiz        | "⚠️ #{number} bajarilmadi. {amount} balansingizga qaytarildi." (+ o‘sha tugma)                                 |
| Tekshirilmoqda         | "⏳ #{number} tekshirilmoqda. Odatda 15 daqiqagacha. Pul xavfsiz." (+ o‘sha tugma)                             |
| Referal bonus          | "🎁 Do‘stingiz xarid qildi — sizga {amount} bonus!"                                                            |
| Bonus kod              | "🎁 Bonus kod faollashtirildi: +{amount}"                                                                      |

Ruscha matnlar `ru.json`da. Xabarlar HTML parse mode, foydalanuvchi matnlari escape qilinadi.

Buyurtma xabarlari (5-bosqich S6): kalitlar `bot.order.*`; tugma Mini App `/tg/orders/:id` ni ochadi
(`MINI_APP_URL` https bo‘lmasa tugmasiz). `{product}` — mahsulot nomi, paket bo‘lsa `Nom (paket)`, erkin
miqdorda `Nom × N`; `{recipient}` — `<code>Ism</code> (@username)`: ism (Telegram’dagi erkin matn) bosiladigan
havolaga aylanmasligi uchun `<code>` ichida, `@username` oddiy matn (Telegram username naqshiga mos kelmasa,
masalan eski yozuvdagi `t.me/x`, u ham `<code>` ichida); ism bo‘lmasa faqat `@username`.
Botni bloklagan foydalanuvchiga yuborilmaydi. Buyurtma xabardagi holatdan o‘tib ketgan bo‘lsa (masalan,
«qabul qilindi» kelguncha yetkazilgan), eski xabar yuborilmaydi. «Muvaffaqiyatsiz» summasi buyurtmaning
`REFUND` yozuvidan olinadi; yetkazilgan buyurtmaning admin refundida bu xabar yuborilmaydi (o‘z xabari S10 da). Egaga
fulfillment alertlari (`alerts.fulfillment.*`) faqat o‘zbekcha, D-53 bo‘yicha hamma sheriklarga
boradi; TON manzili qisqartirilgan (`0:abcd…7890`), cookie, mnemonic va kalit hech qachon yozilmaydi.

Ustuvorlik (`tg-outbox`, 5-bosqich S6): kritik xabarlar navbatda boshqalardan oldin ketadi —
`CRITICAL_OWNER_ALERTS` (`packages/shared/src/notify-fulfillment.ts`): bank feed’dan `foreignChat`,
`bankChatAnomaly`, `listenerStopped`, `listenerDown`; fulfillment’dan `needsReview`, `tonSeqnoUnmatched`,
`tonConsumedUnmatched`, `tonBounced`, `tonWalletBlocked`, `tonWitnessConflict`, `tonWalletCompromised`,
`queueStuck`, `workerDown`. Egaga OTP kodi (admin tasdig‘i) ham kritik: u qisqa yashaydi. Qolgan hamma xabar
oddiy. Chatga 1 xabar/s darvozasi band bo‘lsa, kritik xabar darvoza ochilgan zahoti, oddiy xabar undan
250–500 ms keyin qaytadi, shuning uchun qaytish aylanmasida ham kritik xabar oldinda qoladi.

`queueStuck` (API watchdog, har 30 s): Redis’da bitta kuzatilayotgan job saqlanadi — eng eski kutayotgan
`fulfill-order` job’i, watchdog uni birinchi marta kutayotgan holda ko‘rgan vaqt (Redis `TIME`) va necha
marta olingani. Aynan shu job hali olinmay, birinchi ko‘rilganidan 5 daqiqadan (`QUEUE_STUCK_AFTER_MS`) ko‘p
kutsa — bitta alert (refId = job id + birinchi ko‘rilgan vaqt). Job olinsa yoki yo‘qolsa, keyingi eng eski
kutayotgan job hozirdan kuzatiladi; navbat bo‘sh bo‘lsa kalit o‘chiriladi. Yosh BullMQ qo‘shilgan vaqtidan
hisoblanmaydi: ishlab turgan, lekin band worker (job’lar birin-ketin olinadi) alert bermaydi, qayta urinishga
qaytgan eski job yana 5 daqiqa oladi. `active` holat o‘lchanmaydi (TON to‘lovi bir necha daqiqa `active`
turishi mumkin). Qoldiq: worker job’ni olib, keyin qulasa, job stalled bo‘lib `wait`ga qaytadi va yangidan
kuzatiladi — bu epizod uchun `queueStuck` yo‘q; uni S4 (stalled → review) va S9 qoplaydi.

Runbook: alert manbasini bazadan o‘qib bo‘lmasa (baza ishlamayapti), oxirgi urinishda alert refId’dan
chiqadigan ma’lumot bilan (qolgani `?`) yuboriladi. Bunday alert o‘qilgan paytda allaqachon hal bo‘lgan
holatni tasvirlashi mumkin — avval bazada joriy holatni tekshiring.

## Rassilka (broadcast)

- Admin paneldan: uz va ru matnlari, rasm (ixtiyoriy), tugma, auditoriya (hammasi / til / oxirgi N kun faol /
  xarid qilganlar).
- Har bir foydalanuvchiga o‘z tilida; 25 xabar/s, bitta chatga 1 xabar/s (`tg-outbox` navbati);
  botni bloklaganlarga `User.botBlockedAt` yoziladi (admin bloki `isBlocked` emas, D-28).
- Hisobot: yuborildi / xato / bloklangan.

## Yordam (support)

- `💬 Yordam` → FAQ (Mini App) + "Operatorga yozish": foydalanuvchi xabari support guruhiga
  (topic = foydalanuvchi) forward qilinadi, operator javobi bot orqali qaytadi. Buyurtma raqami
  avtomatik ilova qilinadi. (MVP'da oddiyroq variant: operator akkaunti havolasi — D-07.)

## Texnik

- Prod: webhook + `secret_token`; dev: long polling.
- Rate limit: global ~30 xabar/s, bitta chatga 1 xabar/s; 429 → `retry_after`.
- Har handler uchun uz va ru snapshot test.
