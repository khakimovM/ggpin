# 05 — To‘lovlar (balansni to‘ldirish)

> Provayderlar: **Click, Payme, Uzum, Rahmat** (YaTT shartnomasi bilan), ixtiyoriy **Telegram Stars**.
> Har bir provayderning rasmiy hujjati shartnomadan keyin `docs/providers/<code>.md` ga qo‘yiladi.
> Quyidagi texnik tafsilotlar — yo‘naltiruvchi; **kod faqat rasmiy hujjat asosida yoziladi**.

## Model

```
PaymentIntent (PENDING, summa tiyinda, muddati 30 daq)
   │  foydalanuvchi provayder sahifasiga o‘tadi (redirectUrl)
   ▼
Provayder callback → imzo/auth tekshiruvi → summa va holat tekshiruvi
   ▼  bitta $transaction
Payment(CONFIRMED) + Intent(PAID) + LedgerEntry(TOPUP)  [+ TOPUP_AND_BUY bo‘lsa xarid]
   ▼  commit'dan keyin
balans keshi tozalanadi → bot xabari "Hisobingiz 50 000 so‘mga to‘ldirildi"
```

- Redirect (return URL) **hech qachon** to‘lovni tasdiqlamaydi — faqat holatni ko‘rsatadi.
- `TOPUP_AND_BUY`: xaridni "bir bosishda" yakunlash (yetishmagan summa → to‘lov → avtomatik xarid).
- Minimal/maksimal summa: `TOPUP_MIN_TIYIN` (masalan 500 000 = 5 000 so‘m), `TOPUP_MAX_TIYIN`.

## Click (Shop API: Prepare / Complete)

- Ikki callback: **Prepare** (`action=0`) va **Complete** (`action=1`) — bizning endpointlar.
- Imzo: `sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
  [+ merchant_prepare_id (Complete'da)] + amount + action + sign_time)` — hujjatdan tasdiqlang.
- `merchant_trans_id` = bizning `intentId`; `merchant_prepare_id` = bizning `Payment.id`.
- `amount` so‘mda keladi (kasr bilan) → tiyinga aniq o‘tkaziladi va intent summasi bilan solishtiriladi.
- Javob xato kodlari Click hujjatidagidek (masalan imzo xatosi, summa xatosi, allaqachon to‘langan,
  tranzaksiya topilmadi, bekor qilingan).
- Complete'da `error < 0` kelsa — bekor qilish.

## Payme (Merchant API, JSON-RPC 2.0)

- Bitta endpoint `POST /payments/payme`; auth: `Authorization: Basic base64("Paycom:<KEY>")`.
- Summalar **tiyinda** keladi.
- Metodlar: `CheckPerformTransaction`, `CreateTransaction`, `PerformTransaction`,
  `CancelTransaction`, `CheckTransaction`, `GetStatement` (+ ixtiyoriy `SetFiscalData`).
- `account` maydoni: `{ intent_id }` (kabinetda sozlanadi).
- Tranzaksiya holatlari (1, 2, −1, −2) va vaqt maydonlari (`create_time`, `perform_time`,
  `cancel_time`) hujjatdagidek saqlanadi; qayta so‘rovlarda aynan bir xil javob qaytadi.
- Yaratilgan, lekin bajarilmagan tranzaksiya muddati (hujjatda ~12 soat) — `PerformTransaction`
  kech kelsa rad etiladi.
- `CancelTransaction` bajarilgandan keyin → `TOPUP_REVERSAL`. Foydalanuvchi pulni ishlatib bo‘lgan bo‘lsa:
  reversal baribir yoziladi, balans manfiyga tushadi, `purchaseFrozen=true`, admin ogohlantiriladi.
- Fiskalizatsiya (soliq cheki) talablari — buxgalter bilan aniqlanadi (`docs/13-DECISIONS.md`).

## Uzum, Rahmat

- Shartnoma va hujjat kelgach shu bo‘lim to‘ldiriladi: endpointlar, imzo algoritmi, holatlar,
  qaytarish oqimi, IP allowlist, test muhit.
- Adapter interfeysi bir xil: `createCheckout`, `handleCallback`, `reconcile`.

## Telegram Stars (ixtiyoriy to‘ldirish usuli)

- Bot API `sendInvoice` / `createInvoiceLink` (`currency: "XTR"`), `pre_checkout_query` → tasdiq,
  `successful_payment` → TOPUP (Stars → so‘m kursi admin sozlamasida).
- Telegram komissiyasi va Stars'ni yechib olish (Fragment orqali) shartlari hisobga olinadi.

## Telegram qoidasi haqida muhim eslatma

Telegram hujjatiga ko‘ra bot va Mini App ichida **raqamli mahsulotlar** uchun to‘lov Telegram Stars
orqali bo‘lishi kerak. Bu loyiha uchun qanday yo‘l tanlanishi — **ochiq qaror D-03**
(`docs/13-DECISIONS.md`). Texnik jihatdan arxitektura ikkala variantga tayyor:
- to‘ldirish sahifasi web-domen'da (`/pay/:intentId`), Mini App uni `openLink` bilan ochadi;
- Stars to‘ldirish usuli alohida adapter sifatida yoqilishi mumkin.

## Solishtirish (reconciliation)

- Har kuni 03:00: har bir provayderning kunlik ro‘yxati (Payme `GetStatement`, boshqalarda hisobot API
  yoki kabinet eksporti) bizning `Payment` jadvali bilan solishtiriladi.
- Farqlar admin paneldagi "To‘lovlar → Solishtirish" bo‘limiga tushadi va egaga xabar boradi.

## Testlar (majburiy)

To‘g‘ri oqim · noto‘g‘ri imzo · noto‘g‘ri summa · callback 3 marta · tasdiqdan oldin/keyin bekor
qilish · muddati o‘tgan intent · TOPUP_AND_BUY (kotirovka amal qiladi / amal qilmaydi) · parallel callback'lar.
