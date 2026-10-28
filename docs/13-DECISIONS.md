# 13 — Qarorlar va ochiq savollar

Agentlar bu yerdagi qabul qilingan qarorlarni qayta muhokama qilmaydi. Ochiq savol ish yo‘lini
to‘sib qo‘ysa — to‘xtab egadan so‘raladi.

## Qabul qilingan (2026-10-23)

| # | Qaror |
|---|---|
| D-01 | Stars va Premium **Fragment'dan to‘g‘ridan-to‘g‘ri**, o‘z TON hamyonimiz bilan olinadi. Zaxira — reseller API. |
| D-02 | Birinchi navbatda Stars + Premium (MVP), keyin o‘yinlar ketma-ket: PUBG → MLBB → Steam/CS2 → Roblox → boshqalar. |
| D-05 | Tillar: o‘zbek (standart, lotin) va rus. Admin panel — faqat o‘zbek. |
| D-06 | Stek: NestJS + Prisma + Postgres + Redis/BullMQ; Next.js (web + Mini App); React+Vite (admin); alohida worker. |
| D-09 | Dizayn avval Claude Design'da (`design/DESIGN-BRIEF.md`), keyin implementatsiya. |
| D-10 | Brend nomi kodda faqat `packages/shared/src/brand.ts` va env'da (`BRAND_NAME`, `TELEGRAM_BOT_USERNAME`) turadi, boshqa joyga yozilmaydi. |
| D-11 | Balans modeli (hamyon) + "yetishmagan summani to‘lab, darhol sotib olish" (`TOPUP_AND_BUY`). |
| D-12 | To‘lov provayderlari: Click, Payme, Uzum, Rahmat — YaTT shartnomasi asosida. |
| D-13 | (2026-10-27) Brend: **ggpin** — doim kichik harfda, "gg" = *good game*. Domen `ggpin.uz` (web + Mini App `/tg`), `api.ggpin.uz`, `admin.ggpin.uz`; bot `@ggpin_bot`. |
| D-20 | (2026-10-28) Hosting: **o‘z VPS'imiz**, Docker Compose bilan (Railway emas). Statik IP VPS'dan keladi. |

## Ochiq savollar

| # | Savol | Kim hal qiladi | Qachongacha |
|---|---|---|---|
| D-03 | **Telegram qoidasi:** Mini App ichida raqamli mahsulot uchun to‘lov Stars'da bo‘lishi talab qilinadi. Variantlar: (a) to‘ldirish web-domen'da, Mini App `openLink` bilan ochadi; (b) Stars'ni ham to‘ldirish usuli sifatida qo‘shish; (c) ikkalasi. Xavf darajasini ega baholaydi. | Ega (+ yurist) | 4-bosqichdan oldin |
| D-04 | Birinchi ulanadigan provayder: Click yoki Payme? | Ega | 4-bosqich |
| D-07 | Support: MVP'da operator akkaunti havolasi yoki bot ichidagi support chat (guruh + topic)? | Ega | 7-bosqich |
| D-08 | Analytics: Yandex Metrica / GA4 / PostHog? | Ega | 8-bosqich |
| D-14 | So‘m → USDT/TON konvertatsiyasi qaysi litsenziyali birja orqali, buxgalteriya va soliq hisobi | Ega + buxgalter | Launch'dan oldin |
| D-15 | Fiskal chek (OFD) talablari to‘lov provayderlari orqali | Ega + buxgalter | Launch'dan oldin |
| D-16 | Ommaviy oferta, maxfiylik siyosati, qaytarish qoidalari matnlari | Ega + yurist | 8-bosqich |
| D-17 | Keshbek foizi, referal foizi (1%?), chegirma tier'lari, ustamalar | Ega | 10-bosqich |
| D-18 | NFT gift ijarasi (buypin'dagi "Ijaraga") kerakmi va qachon? | Ega | MVP'dan keyin |
| D-19 | O‘yinlar uchun ta'minotchilar (FazerCards, WDGZone, MooGold, Smile.one...) — test buyurtmalardan keyin tanlanadi | Ega | Har G-bosqichdan oldin |
