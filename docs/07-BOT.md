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

Premium misoli (6-bosqich; paket nomi oylar bilan, `bot.order.*` katalogi, `order-notify-premium.spec.ts` snapshot’i; Premium paketlari
3, 6 va 12 oy). Qabul qilindi (uz): «🧾 #1042 buyurtma qabul qilindi: Telegram Premium (3 oylik) → <code>Test User</code>
(@test_user)»; ru: «🧾 Заказ #1042 принят: Telegram Premium (3 месяца) → <code>Test User</code> (@test_user)». Yetkazildi (uz):
«🎉 #1042 yetkazildi! Telegram Premium (3 oylik) → <code>Test User</code> (@test_user)»; ru: «🎉 Заказ #1042 выполнен! Telegram Premium
(3 месяца) → <code>Test User</code> (@test_user)». 6 va 12 oyda faqat paket nomi o‘zgaradi («6 oylik», «12 oylik» / «6 месяцев»,
«12 месяцев»). Kotirovkadan keyin qabul qiluvchida Premium paydo bo‘lib buyurtma qaytarilsa, mijozga oddiy «Muvaffaqiyatsiz»
xabari boradi (sababi xabarda ko‘rsatilmaydi; u faqat admin voqealar tarixida).
Botni bloklagan foydalanuvchiga yuborilmaydi. Buyurtma xabardagi holatdan o‘tib ketgan bo‘lsa (masalan,
«qabul qilindi» kelguncha yetkazilgan), eski xabar yuborilmaydi. «Muvaffaqiyatsiz» summasi buyurtmaning
`REFUND` yozuvidan olinadi; yetkazilgan buyurtmaning admin refundida bu xabar yuborilmaydi (o‘z xabari S10 da). Egaga
fulfillment alertlari (`alerts.fulfillment.*`) faqat o‘zbekcha, D-53 bo‘yicha hamma sheriklarga
boradi; TON manzili qisqartirilgan (`0:abcd…7890`), cookie, mnemonic va kalit hech qachon yozilmaydi.

Ustuvorlik (`tg-outbox`, 5-bosqich S6): kritik xabarlar navbatda boshqalardan oldin ketadi —
`CRITICAL_OWNER_ALERTS` (`packages/shared/src/notify-fulfillment.ts`): bank feed’dan `foreignChat`,
`bankChatAnomaly`, `listenerStopped`, `listenerDown`; fulfillment’dan `needsReview`, `tonSeqnoUnmatched`,
`tonConsumedUnmatched`, `tonBounced`, `tonWalletBlocked`, `tonWitnessConflict`, `tonWalletCompromised`,
`queueStuck`, `workerDown`; S9 reconciler’idan `orderNoPurchase`, `reconcileGuardRefused`, `tonLateConfirmed`. Egaga OTP kodi (admin tasdig‘i) ham kritik: u qisqa yashaydi. Qolgan hamma xabar
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
kuzatiladi — bu epizod uchun `queueStuck` yo‘q; uni S4 (stalled → review) va S9 reconciler’ining `stale` / `lockStuck` qadamlari qoplaydi (`needsReview`, refId `<orderId>_lock_<soat>` va `<orderId>_abandoned_<kun>`, pastda).

Runbook: alert manbasini bazadan o‘qib bo‘lmasa (baza ishlamayapti), oxirgi urinishda alert refId’dan
chiqadigan ma’lumot bilan (qolgani `?`) yuboriladi. Bunday alert o‘qilgan paytda allaqachon hal bo‘lgan
holatni tasvirlashi mumkin — avval bazada joriy holatni tekshiring.

### 5-faza S9: reconcile alertlari va refId formatlari

Alert turlari `packages/shared/src/fulfillment/fulfillment-alerts.ts` da, parametrlari — `FULFILLMENT_ALERT_PARAMS` (`notify-fulfillment.ts`), matnlari — `packages/i18n/{uz,ru}.json` (`alerts.fulfillment.*`), renderer — `apps/api/src/modules/notifications/fulfillment-alert.renderer.ts`. Worker faqat **nima bo‘lganini** aytadi (`OWNER_ALERT` + `refId`), matnni API tegishli qatordan o‘qib chiqaradi. Bir xil `refId` — bir xil `notify` job id (30 kunlik dublikat oynasi, `NOTIFY_DEDUPE_SEC`), shuning uchun takroriy epizod yangi `refId` talab qiladi. Murakkab `refId` ning boshidagi id (birinchi `_` gacha) qatorni topish uchun `refIdSubject` bilan o‘qiladi (`<id>_<qo‘shimcha>`, qo‘shimcha ≤ 40 belgi, jami ≤ 64).

Yangi kritik alertlar (S9, D-64 (6), (7); `CRITICAL_OWNER_ALERTS` da, navbatda oldinda ketadi):

| Alert                   | Qachon                                                                                                                                                                                            | `refId`                                   | Parametrlar                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `orderNoPurchase`       | Buyurtmaning `PURCHASE` yozuvi yo‘q yoki summasi mos emas. Hech narsa yuborilmagan, buyurtma faqat egada (avtomatik bo‘shatish va refund yo‘q)                                                    | `<orderId>` (buyurtmaga bitta)            | `number`, `product`, `ref`                         |
| `reconcileGuardRefused` | Reconciler yozuvini DB qo‘riqchisi (`GG001`) rad etdi, yoki HELD buyurtmaga tegib bo‘lmaydi. Qayta urinilmaydi; ega qo‘lda ko‘radi                                                                | `<orderId>_<epizod>_<davr>` (pastda)      | `number`, `status`, `ref`                          |
| `tonLateConfirmed`      | «Yuborilmagan» deb hisoblangan transfer (`EXPIRED`/`CONSUMED_UNMATCHED`) zanjirda keyin topildi yoki hint qabul qilindi: pul ikki marta chiqqan bo‘lishi mumkin. Buyurtma va ledger'ga tegilmaydi | `<transferId>` (boshqa shakllar — pastda) | `number`, `seqno`, `amount`, `to`, `status`, `ref` |

`tonSeqnoUnmatched` parametrlari `number`, `seqno`, `amount`, `ref` (D-64 (6), Q-5); matni (uz): «🚨 KRITIK: TON hamyonning seqno {seqno} raqami bizga nomaʼlum xabar bilan ishlatildi (#{number} buyurtma, {amount}). Kalitni boshqa kimdir ishlatgan bo‘lishi mumkin. Yuborishlarni to‘xtating. Transfer: {ref}»; ruscha matn — `ru.json` da. Alert ikki manbadan chiqadi: TON moduli seqno o‘tib ketganda (refId = `<transferId>`) va Z6 hint tekshiruvi `FOREIGN_MESSAGE` topganda (refId = `<transferId>_foreign`: bizning kalit buyurtmaga aloqasiz xabar imzolagan; docs/06 «Z6»).

Reconciler bir alert turini turli epizodlar uchun qayta chiqarishi mumkin, shuning uchun `refId` ga **epizod** qo‘shiladi. Format va davrlar yagona joyda — `apps/worker/src/common/episode-ref.ts` (`episodeRef`, `walletBlockedRef`); format literal id'lar testi bilan qotirilgan (o‘zgarsa, ochiq epizodlar qayta yuborilardi). Davr DB soati bo‘yicha: soat = `floor(ms / 3 600 000)`, kun = `floor(ms / 86 400 000)`:

| Epizod (scope)  | Alert turi              | `refId`                                           | Davr             | Qachon                                                                                                                                                                                                             |
| --------------- | ----------------------- | ------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review`, `ton` | `reconcileGuardRefused` | `<orderId>_review_<soat>`, `<orderId>_ton_<soat>` | soat             | `NEEDS_REVIEW` hal qilishni yoki TON transfer tekshiruvi / kech fakt yozuvini guard rad etdi; kech abort (`lateDestination`) ham shu `ton` epizodida                                                               |
| `held`          | `reconcileGuardRefused` | `<orderId>_held_<soat>`                           | soat             | HELD buyurtmaga tegib bo‘lmaydi: guard rad etdi, tirik to‘lov, yoki HELD hodisasi yo‘q                                                                                                                             |
| `heldlate`      | `reconcileGuardRefused` | `<orderId>_heldlate_<kun>`                        | kun              | HELD buyurtma kech zanjir fakti yonida saqlandi (faqat ega tugata oladi: soatlik takror shovqin bo‘lardi)                                                                                                          |
| `heldlive`      | `reconcileGuardRefused` | `<orderId>_heldlive_<kun>`                        | kun              | HELD buyurtma `EXPIRED` dan boshqa transfer yonida saqlandi                                                                                                                                                        |
| `cu`            | `tonConsumedUnmatched`  | `<transferId>_cu_<soat>`                          | soat             | `NEEDS_REVIEW` da `CONSUMED_UNMATCHED` transfer: ega hal qilguncha soatiga eslatma                                                                                                                                 |
| `lock`          | `needsReview`           | `<orderId>_lock_<soat>`                           | soat             | `lock:order:{id}` ≥ 30 daqiqa osilgan (oddiy `<orderId>` buyurtmaning haqiqiy `needsReview` alerti uchun bo‘sh qoladi)                                                                                             |
| `abandoned`     | `needsReview`           | `<orderId>_abandoned_<kun>`                       | kun              | `fulfill-order` qayta urinishlari tugagan; settle ham, reconciler ham shu bir xil kunlik id ni yasaydi — bir kunda bitta alert                                                                                     |
| `wb`            | `tonWalletBlocked`      | `<transferId>_wb_<n>`                             | 6 soat (blokdan) | Hamyonni bloklab turgan transfer; `n` — blokdan o‘tgan to‘liq 6 soatliklar soni, shuning uchun TON modulining birinchi alertidan (refId = oddiy `<transferId>`) keyin birinchi eslatma to‘liq davrdan so‘ng ketadi |

Epizodsiz, lekin qo‘shimchali refId'lar:

| Alert                 | `refId`                    | Ma’nosi                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tonLateConfirmed`    | `<transferId>_<attemptId>` | Oldingi (kech topilgan) transfer tufayli urinish imzolanmadi (M-1 darvozasi); har rad etilgan urinish bir marta                                                                                                                                                         |
| `tonLateConfirmed`    | `<T1>_<auditId>`           | Eganing hint'i (`OTHER_TRANSFER`) buyurtmaning **boshqa** transferi T1 xabari zanjirga chiqqanini ko‘rsatdi, buyurtma esa allaqachon terminal (`DELIVERED`/`FAILED`/`REFUNDED`/`CANCELLED`). T1 ning o‘z alerti oddiy `<T1>` id'sini saqlaydi; belgi bir marta yoziladi |
| `tonSeqnoUnmatched`   | `<transferId>_foreign`     | Z6 hint `FOREIGN_MESSAGE`; hint aylanishining har turida saqlangan faktdan qayta navbatga qo‘yiladi                                                                                                                                                                     |
| `needsReview`         | `<orderId>_<transferId>`   | `ONCHAIN_FAILED` isbotlandi: endi eganing `TON_NOT_DEBITED` isboti buyurtmani hal qila oladi (oddiy `<orderId>` buyurtmaning o‘z `needsReview` alerti uchun band)                                                                                                       |
| `reviewResolved`      | `<orderId>_<auditId>`      | Buyurtma `NEEDS_REVIEW` dan chiqdi (reconciler yoki ega); audit qatori id'si bilan                                                                                                                                                                                      |
| `heldExpiredRefunded` | `<orderId>`                | HELD muddati tugab refund qilindi (mijozga `ORDER_REFUNDED` / `<orderId>` bilan juft)                                                                                                                                                                                   |
| `tonBounced`          | `<transferId>`             | Bounce; kech topilganda ham shu id                                                                                                                                                                                                                                      |

Commit'dan keyin API yoki worker qulaganda yo‘qolgan navbatga qo‘yishlar reconciler tomonidan o‘sha id'lar bilan tiklanadi: `noticeResend` (HELD va `NEEDS_REVIEW` xabarlari), `auditEffects` (AuditLog qatorlaridan: mijoz xabari, `reviewResolved`, `adminAction`, `tonWalletCompromised`, kesh `DEL`), `late` (saqlangan faktdan `tonLateConfirmed`, `tonBounced`, `tonSeqnoUnmatched`, T1 uchun `<T1>_<auditId>`). Id'lar bir xil bo‘lgani uchun ega bir xabarni ikki marta olmaydi (docs/06 «5-faza S9: reconcile»).

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
