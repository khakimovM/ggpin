# Handoff bundle

Claude Design eksporti: `GGPin Design System Final.zip`, 2026-10-29. 0–9-raundlar to‘liq.
10-raund (P2P karta orqali to‘ldirish, `design/DESIGN-BRIEF.md` Prompt 10) 2026-11-04
eksportidan qo‘shildi: `TopupMini.dc.html`, `PayPage.dc.html`, `Round 10 - Card Top-up.dc.html`,
hamda Click/Payme matni karta o‘tkazmasiga almashgan `Account.dc.html` va `Site.dc.html`.
Fayllar eksportdagidek, o‘zgartirilmagan. Yangilash uchun qayta eksport qilib, fayllarni
butunlay almashtiring; faqat shu README saqlanadi. Ekranni qurish:
`/implement-design <ekran nomi>`.

## Avval o‘qing (shu tartibda)

1. `ggpin-tokens.css` — barcha token’lar: ranglar (`:root` yorug‘, `[data-theme="dark"]`
   qorong‘i), radius, shrift, motion (`--dur-*`, `--ease-*`), `gg-*` keyframe’lar,
   reduced motion. 7-bosqichda `packages/ui/tokens.css` ga 1:1 ko‘chiriladi, yangi rang yo‘q.
2. `ggpin Design System.dc.html` — komponentlar va ularning holatlari.
3. `Round 9 - Handoff.dc.html` — qamrov jadvali (ekran × 390/768/1440 × dark × RU × holatlar),
   status chip’lar (uz/ru matn + token), pul/sana formatlash qoidalari, motion vaqt shkalalari,
   komponent inventari (`packages/ui` uchun ro‘yxat).
4. `Round 9 - Russian QA.dc.html` — ruscha matn sig‘ishi bo‘yicha 10 ta majburiy tuzatish
   (tugmalar `nowrap` emas, chip’lar o‘raladi, RU’da menyu ≤1180px, “so‘m” → “сум” va h.k.).

## Ekran fayllari (manba)

Har bir fayl bitta komponent; holatlar `data-props` dagi parametrlar bilan almashadi.

| Fayl                     | Nima                                   | Asosiy parametrlar                                                                                   |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Site.dc.html`           | Landing, mahsulot SEO, 404, xato, to‘lovdan qaytish | `page`: landing, product, 404, error, pay-checking/success/failed · `viewport`: desktop, mobile · `hero` |
| `Login.dc.html`          | Web va admin kirish (OTP)              | `theme`                                                                                              |
| `MiniApp.dc.html`        | Splash, gate’lar, til tanlash, bosh sahifa | `screen`: splash, gate-bot, gate-blocked, gate-offline, lang, home                                 |
| `Product.dc.html`        | Mahsulot sahifalari                    | `product`: stars, premium, pubg, mlbb, steam, cs2, roblox · `recipient` · `pageState`                |
| `Checkout.dc.html`       | Tasdiqlash, mablag‘ yetmasligi, to‘ldirish, buyurtma holati | `screen`: confirm*, insufficient, topup*, order                                 |
| `Account.dc.html`        | Tarix, profil, referal, kuponlar, bonus, yordam | `screen`: history, profile, referral, coupons, bonus, help                                  |
| `Store.dc.html`          | Web do‘kon (desktop/planshet)          | `page`: catalog, product, order, history, profile · `modal` · `topupStep`                            |
| `Admin.dc.html`          | Admin: dashboard, buyurtmalar, review  | `page`: dashboard, orders, order, review · `viewport`: desktop, tablet                               |
| `AdminOps.dc.html`       | Admin operatsiyalar                    | `page`: users, products, pricing, payments, recon, wallet, fragment, suppliers, queues, bonus, broadcast, refs, audit, admins |
| `RuScreens.dc.html`      | Asosiy ekranlarning ruscha varianti    | `screen`: home, stars, pubg, confirm, insufficient, order, topup, profile, hero, login               |
| `TopupMini.dc.html`      | Mini App: P2P to‘ldirish (10-raund)    | `screen`: amount, waiting, home, insufficient, finance · `wait` · `amount-err` · `amount-state` · `buy-variant` · `lang` |
| `PayPage.dc.html`        | `/pay/<id>` sahifasi va web do‘kon to‘ldirish modali (10-raund) | `mode`: page, store · `state`: pending, warn, loading, credited, expired, cancelled, invalid, netError · `store-step` · `viewport` · `lang` |

Hamma ekran fayllarida `theme`: light, dark bor. Mobil kenglik — 390.

**10-raund almashtirgan ekranlar:** `Checkout.dc.html` dagi `topup*` ekranlari, `Store.dc.html` dagi
`topupStep` modali va `RuScreens.dc.html` dagi `topup` — Click/Payme/Uzum/Rahmat uchun chizilgan,
P2P’da ishlatilmaydi (D-04, D-31, D-37). To‘ldirish faqat `TopupMini` va `PayPage` dan quriladi.

## Qolgan fayllar

- `Round N - *.dc.html` — ko‘rib chiqish taxtalari. Ekran fayllarini `<dc-import name="…">`
  orqali turli parametrlar bilan yonma-yon ko‘rsatadi; o‘zining dizayni yo‘q, manba emas.
  Istisno: `Round 9 - Bot Assets` (bot rasmlari) va yuqoridagi ikkita Round 9 fayli.
- `support.js`, `image-slot.js` — Claude Design runtime’i (generatsiya qilingan, React 18 UMD
  va Babel’ni unpkg’dan yuklaydi). Faqat prototiplarni ko‘rsatish uchun; ilovaga import
  qilinmaydi, tahrirlanmaydi.
- `.thumbnail` — loyiha muqovasi (WebP).
- Yuklangan reference rasmlar: `design/references/`.

## Dizayn o‘zi ko‘rsatgan bo‘shliqlar (Round 9 qamrov jadvali)

| Ekran                        | Bo‘shliq                          | Dizayndagi tavsiya                               |
| ---------------------------- | --------------------------------- | ------------------------------------------------ |
| Mahsulot SEO sahifasi        | RU varianti yo‘q                  | Katalog muharriridagi UZ/RU matnlardan foydalanish |
| 404 / xato / to‘lovdan qaytish | RU varianti yo‘q                | Qisqa matnlar; xato lug‘atiga moslash            |
| Web do‘kon                   | RU varianti yo‘q                  | 390 dagi web = brauzerdagi Mini App maketlari    |
| Admin (Round 7 va 8)         | Jadval skeleton / bo‘sh / xato holatlari yo‘q | Barcha jadvallar uchun bitta umumiy DataTable holatlar to‘plami |
| Bot rasmlari                 | RU varianti yo‘q                  | Sarlavha matnini almashtirish                    |

## Kodga o‘tkazishda e’tibor

- Dizayndagi bot havolalari `t.me/ggpinbot`; haqiqiy bot `@ggpin_bot`. Kodda hech biri
  yozilmaydi — `NEXT_PUBLIC_BOT_USERNAME` va `packages/shared/src/brand.ts` dan olinadi.
- Balanslar, referal kodlar, Telegram ID’lar, tranzaksiyalar — namunaviy ma’lumot.
- Shriftlar: Manrope (matn), Unbounded (display), Google Fonts orqali. Ikonlar: Lucide
  (`lucide-static@0.469.0`) — ilovada `lucide-react`.
- Matnlar to‘g‘ridan-to‘g‘ri olinmaydi: hammasi `packages/i18n` kalitlari orqali (uz + ru).
