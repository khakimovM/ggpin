# 11 — Yo‘l xaritasi

Agent keyingi vazifani **shu fayldan** oladi (`/next-task`). Bosqichlar ketma-ket. Bosqich tugagach
`/phase-report` va **to‘xtash** — keyingisi ega tasdig‘idan keyin. Belgilash faqat isbot bilan.

Umumiy reja: **Dizayn → Asos → Stars va Premium (MVP) → Ishga tushirish → O‘yinlar birin-ketin.**

---

## D — Dizayn (Claude Design, egasi bajaradi)

**Vazifa:** `design/DESIGN-BRIEF.md` dagi promptlarni tartib bilan Claude Design'ga yuborish
(0 → 9 raundlar), natijani ko‘rib tuzatish, handoff bundle'ni `design/handoff/` ga qo‘yish.
Bu bosqich davomida 0–2-bosqichlar (backend asosi) parallel ketishi mumkin.

**Qabul mezonlari**

- [x] Dizayn tizimi (token'lar yorug‘/qorong‘i, komponentlar) tayyor
- [x] Landing, Mini App (bosh sahifa, mahsulot, tasdiqlash, holat, to‘ldirish, tarix, profil, referal) tayyor
- [x] Web do‘kon desktop varianti va admin panel ekranlari tayyor
- [x] Ruscha matn sig‘ishi tekshirilgan (yakuniy raund; qolgan RU bo‘shliqlari —
      `design/handoff/README.md`)
- [x] Handoff bundle `design/handoff/` da, `README.md` bilan

---

## 0 — Monorepo skeleti

**Vazifa:** npm workspaces + Turborepo; `apps/api` (Nest + Fastify), `apps/worker` (Nest standalone),
`apps/web` (Next.js 15), `apps/admin` (Vite + React), `packages/shared`, `packages/i18n`, `packages/ui`;
ESLint, Prettier, Husky + lint-staged + gitleaks; tsconfig bazasi; `docker-compose.yml` (Postgres 16,
Redis 7); `.env.example` har ilova uchun; root skriptlar; CI workflow.

**Qabul mezonlari**

- [x] `npm install`, `npm run db:up`, `npm run dev` — to‘rt ilova ishga tushadi
- [x] `npm run verify` yashil (bo‘sh testlar bilan)
- [x] `GET /api/v1/health/live` → `{status:"ok"}`
- [x] i18n paketi: uz/ru kalitlar paritet testi bor
- [x] CI GitHub Actions'da yashil

---

## 1 — Baza va infratuzilma

**Vazifa:** `docs/03-DATA-MODEL.md` sxemasini qo‘llash, birinchi migratsiya, Prisma (api + worker),
Redis, BullMQ, Zod env validatsiyasi (worker sirlari API'da bo‘lsa ishga tushmaslik), global
interceptor/filter/pipe, Pino (redaksiya bilan), Swagger, Throttler, Helmet, CORS, `money.ts`,
`order-state.ts` (to‘liq testlar bilan).

**Qabul mezonlari**

- [x] Migratsiya barcha modellarni yaratadi, `prisma validate` yashil
- [x] Env yetishmasa ilova ishga tushmaydi va sababni aytadi
- [x] `money.ts` va `order-state.ts` 100% unit test qamrovi (taqiqlangan o‘tishlar xato beradi)
- [x] Xato konverti shartnomaga mos, `BigInt` JSONda string
- [x] Logda sirlar redakt qilinishi testlangan

---

## 2 — Autentifikatsiya va bot asosi

**Vazifa:** Mini App `initData` auth; web OTP (bot orqali); refresh rotatsiya; bot: `/start`, til tanlash,
menu button, payload'lar (`ref_`, `login_`), outbox navbati; `User`/`Wallet` yaratish; referal bog‘lash.

**Qabul mezonlari**

- [x] initData: to‘g‘ri / soxta / eskirgan testlari
- [x] Web: start → botda kod → verify → cookie → `/me`; 5 urinish va muddat ishlaydi
- [x] Bot uz/ru: `/start`, til almashtirish, snapshot testlar
- [x] `ref_` payload faqat birinchi marta bog‘laydi, o‘zini taklif qilish rad etiladi

---

## 3 — Katalog va narx

**Vazifa:** kategoriyalar, mahsulotlar, SKU, `inputSchema`, seed (Stars, Premium); FX kurslari;
narx sinxronlash (Fragment narxi — dry-run simulyatordan); kotirovka endpointi; `fromPrice`.

**Qabul mezonlari**

- [x] `GET /catalog/*` lokalga mos nomlar bilan
- [x] Kotirovka: 10 daq muddat, foydalanuvchiga bog‘langan, `maxCost` hisoblangan
- [x] Eski kurs bo‘lsa kotirovka berilmaydi (test)
- [x] Yaxlitlash qoidalari testlangan

---

## 4 — Hamyon va to‘lovlar (P2P karta, D-31/D-37)

**Vazifa:** ledger (TOPUP, TOPUP_REVERSAL, ADJUSTMENT), balans + Redis kesh, `/me/wallet`, `/me/ledger`; P2P to‘ldirish
so‘rovi (noyob summa, TTL, karta tanlash, havola tokeni); karta puli (VERIFYING/ACTIVE/FULL/RETIRED, limit, test o‘tkazma);
bank xabarlari tinglovchisi (MTProto, faqat worker); Humo/Uzcard parserlari; moslashtirish + TOPUP (bitta `$transaction`,
xabar id bo‘yicha idempotent); tekshiruv navbati (servis + ega CLI); kunlik solishtirish; bot xabarlari va ega
ogohlantirishlari. `TOPUP_AND_BUY` — faqat `purpose` maydoni, avtomatik xarid 5-bosqichda. Spec: `docs/05-PAYMENTS.md`.

**Qabul mezonlari**

- [ ] Fake tinglovchi + fixture bilan to‘liq oqim: so‘rov → pay sahifasi API → xabar → TOPUP → bot xabari → `/me/wallet`
- [ ] Bitta xabar 3 marta (update + tarix + qayta ishga tushish) → bitta TOPUP; parallel 2 ishlovchi → bitta TOPUP
- [ ] Tanilmagan / forward / tahrir / begona yuboruvchi / zanjir buzilishi / mos kelmagan / grace’dan keyingi kech / takroriy → avtomatik yozilmaydi, review + alert
- [ ] Bitta kartada 50 parallel so‘rov → 50 xil summa; summa `reservedUntil` gacha band (exclusion constraint); ikkinchi kutilayotgan so‘rov rad
- [ ] Bekor qilingan (`CANCELLED`) so‘rovga kelgan pul avtomatik yozilmaydi (review `CANCELLED_LATE`); muddati o‘tgan (`EXPIRED`) grace ichida yoziladi
- [ ] Bir vaqtda ko‘pi bilan 3 to‘lanmagan band so‘rov (`PAID` sanalmaydi), kuniga 10 so‘rov (`429` + `Retry-After`)
- [ ] Kunlik cheklar ASOS summa bo‘yicha: barcha akkaunt 5 000 000 so‘m, yangi akkaunt 500 000 so‘m (aynan 500 000 ruxsat, 501 000 → `422`, `details.max` = qolgan limit); pul yozilayotganda ikkalasi qayta tekshiriladi → review `DAILY_LIMIT`
- [ ] Karta `DRAINING`: yangi so‘rov berilmaydi, mavjudlari `reservedUntil` gacha yoziladi, keyin `RETIRED`
- [ ] Har DEBIT haqida egaga alert; yaqinda yozilgan to‘lovga teng chiqim → review `POSSIBLE_REVERSAL`; bloklangan foydalanuvchi → review `USER_BLOCKED`
- [ ] FULL/VERIFYING kartaga yo‘naltirilmaydi; FULL kartaga yo‘ldagi to‘lov yoziladi
- [ ] Noma’lum yangi avtorizatsiya → hamma kartada avtomatik yozish to‘xtaydi + alert; jim karta (kunduzgi soatlar) → bitta alert
- [ ] Havola tokeni URL fragmentida (`#t=`): begona / eski / rotatsiya qilingan / muddati o‘tgan / noto‘g‘ri `intentId` → bir xil 404; javobda faqat so‘rov ma’lumoti va `ownerHint`
- [ ] Sessiya satri va havola tokeni logda/javobda yo‘q; worker sirlari API’da bo‘lsa boot rad
- [ ] **Ega ruxsati bilan:** haqiqiy ishchi akkaunt + test karta, kichik o‘tkazma hisobga tushdi; zanjir har operatsiyada uzilmadi
- [ ] `security-auditor` — to‘lov moduli va bank-feed bo‘yicha critical/high yo‘q

---

## 5 — Buyurtmalar va yetkazish freymvorki + Telegram Stars

**Vazifa:** qabul qiluvchini tekshirish navbati, `POST /orders` (qulf, idempotentlik), `fulfill-order`
worker, adapter router, `FragmentAdapter` (Stars), TON moduli (seqno lock, yuborish, tasdiq),
simulyator, NEEDS_REVIEW/HELD, reconcile, bot xabarlari, Fragment sessiyasi (keep-alive, health).

**Qabul mezonlari**

- [ ] Dry-run: Stars buyurtmasi PAID → DELIVERED, bot xabari keladi
- [ ] Ikki parallel xarid (balans bittaga yetadi) → bitta 201, bitta 422
- [ ] Worker yuborish o‘rtasida "o‘lsa" — qayta ishga tushganda qayta yubormaydi (test)
- [ ] Noma'lum natija → NEEDS_REVIEW; narx oshsa → HELD; limit → HELD
- [ ] Sessiya DEAD → zaxira adapter (simulyator) ga o‘tish va ogohlantirish
- [ ] **Ega ruxsati bilan:** mainnet'da 50 Stars egasining akkauntiga real yetkazildi
- [ ] `security-auditor` — worker bo‘yicha critical/high yo‘q

---

## 6 — Telegram Premium

**Vazifa:** Premium 3/6/12 oy (Fragment), qabul qiluvchida Premium bor holati, narxlar, testlar.

**Qabul mezonlari**

- [ ] Dry-run: Premium buyurtmasi DELIVERED
- [ ] "Premium allaqachon bor" holati to‘g‘ri ko‘rsatiladi
- [ ] Ega ruxsati bilan: real 3 oylik Premium sovg‘a qilindi

---

## 7 — Mini App va web do‘kon (dizayn asosida)

**Vazifa:** `packages/ui` (token'lar, komponentlar), Mini App barcha ekranlari, web do‘kon (desktop),
login sahifasi, to‘lov natija sahifasi, uz/ru, animatsiyalar.

**Qabul mezonlari**

- [ ] e2e-qa: 1–4-sayohatlar yashil (`.claude/agents/e2e-qa.md`)
- [ ] Skrinshotlar 375/768/1440 × yorug‘/qorong‘i × uz/ru, dizayndan og‘ishlar ro‘yxati bo‘sh yoki tasdiqlangan
- [ ] Har ekranda 4 holat
- [ ] Telegram iOS/Android/Desktop'da qo‘lda sinab ko‘rilgan (ega)

---

## 8 — Landing va SEO

**Vazifa:** landing, mahsulot SEO sahifalari (Stars, Premium), FAQ, oferta/maxfiylik sahifalari
(matnlar yurist bilan), sitemap, hreflang, OpenGraph, analytics (D-08).

**Qabul mezonlari**

- [x] Lighthouse ≥ 90 (Performance, SEO, Accessibility) uz va ru'da
- [x] Sitemap va hreflang to‘g‘ri

---

## 9 — Admin panel

**Vazifa:** admin auth (OTP + allowlist + rollar), dashboard, buyurtmalar (tafsilot, amallar, tekshiruv
navbati), foydalanuvchilar, katalog, narx sozlamalari, to‘lovlar, hamyon/Fragment/navbatlar holati,
audit log, adminlar.

**Qabul mezonlari**

- [ ] Rollar testlari: SUPPORT o‘zgartira olmaydi, OPERATOR limitdan katta qaytara olmaydi
- [ ] Har bir amal audit log yozadi (test)
- [ ] Katta pul amallarida qo‘shimcha kod so‘raladi
- [ ] Ruxsatsiz → 404
- [ ] Admin bitta `@repo/ui/styles.css` kirish faylini import qiladi (tokenlar, `theme.css`, `dark` varianti); `dark:` klasslari (danger tugma, premium badge) ikkala mavzuda ishlaydi
- [ ] `security-auditor` — admin bo‘yicha critical/high yo‘q

---

## 10 — Referal, keshbek, chegirma va bonus kodlar, qolgan to‘lov usullari

**Vazifa:** referal bonus (DELIVERED'da), keshbek tangalar, chegirma tier'lari va kodlari, bonus kodlar,
rassilka, to‘lov provayderlari Click/Payme/Uzum/Rahmat (D-04 qayta ko‘rilganda), Telegram Stars to‘ldirish (D-33).

**Qabul mezonlari**

- [ ] Referal/keshbek faqat DELIVERED'da, admin qaytarishida bekor bo‘ladi
- [ ] Kodlar bir martalik, brute force rate limit
- [ ] Har yangi provayder (D-04 qayta ko‘rilganda) 4-bosqich testlaridan o‘tgan

---

## 11 — Ishga tushirishga tayyorgarlik (MVP launch)

**Vazifa:** VPS production (Docker Compose, reverse proxy + TLS), monitoring va ogohlantirishlar, backup + restore sinovi, yuklama testi,
`/security-check all`, `claude-security` skaneri, `docs/10-SECURITY.md` ro‘yxati, soft launch (yopiq beta).

**Qabul mezonlari**

- [ ] Xavfsizlik ro‘yxati to‘liq bajarilgan
- [ ] 50 ta beta foydalanuvchi bilan 1 hafta: yetkazish ≥ 99%, NEEDS_REVIEW < 0,5%
- [ ] Ega "ishga tushiramiz" dedi

---

## G1 — PUBG Mobile UC

**Vazifa:** ta'minotchi tanlash (ega), `docs/suppliers/<code>.md`, adapter, Player ID tekshiruvi,
SKU'lar (UC tezkor / To‘plamlar), "ID'ni qanday topaman" kontenti, dry-run va real test. (`/add-game`)

**Qabul mezonlari**

- [ ] Noto‘g‘ri ID / region / stok yo‘q / timeout holatlari testlangan
- [ ] Ega ruxsati bilan real 60 UC yetkazildi

---

## G2 — Mobile Legends

- [ ] User ID + Zone ID formasi, region ogohlantirishi, real test

## G3 — Steam (+ CS2)

- [ ] Login orqali to‘ldirish, profil tasdig‘i, komissiya ustamasi, CS2 kartochkasi, real test

## G4 — Roblox

- [ ] Voucher ombori (import, qoldiq, band qilish) yoki direct API, real test

## G5+ — Boshqa o‘yinlar

- [ ] Har biri `/add-game` orqali, alohida PR
