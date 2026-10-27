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
- [ ] Dizayn tizimi (token'lar yorug‘/qorong‘i, komponentlar) tayyor
- [ ] Landing, Mini App (bosh sahifa, mahsulot, tasdiqlash, holat, to‘ldirish, tarix, profil, referal) tayyor
- [ ] Web do‘kon desktop varianti va admin panel ekranlari tayyor
- [ ] Ruscha matn sig‘ishi tekshirilgan (yakuniy raund)
- [ ] Handoff bundle `design/handoff/` da, `README.md` bilan

---

## 0 — Monorepo skeleti
**Vazifa:** npm workspaces + Turborepo; `apps/api` (Nest + Fastify), `apps/worker` (Nest standalone),
`apps/web` (Next.js 15), `apps/admin` (Vite + React), `packages/shared`, `packages/i18n`, `packages/ui`;
ESLint, Prettier, Husky + lint-staged + gitleaks; tsconfig bazasi; `docker-compose.yml` (Postgres 16,
Redis 7); `.env.example` har ilova uchun; root skriptlar; CI workflow.

**Qabul mezonlari**
- [ ] `npm install`, `npm run db:up`, `npm run dev` — to‘rt ilova ishga tushadi
- [ ] `npm run verify` yashil (bo‘sh testlar bilan)
- [ ] `GET /api/v1/health/live` → `{status:"ok"}`
- [ ] i18n paketi: uz/ru kalitlar paritet testi bor
- [ ] CI GitHub Actions'da yashil

---

## 1 — Baza va infratuzilma
**Vazifa:** `docs/03-DATA-MODEL.md` sxemasini qo‘llash, birinchi migratsiya, Prisma (api + worker),
Redis, BullMQ, Zod env validatsiyasi (worker sirlari API'da bo‘lsa ishga tushmaslik), global
interceptor/filter/pipe, Pino (redaksiya bilan), Swagger, Throttler, Helmet, CORS, `money.ts`,
`order-state.ts` (to‘liq testlar bilan).

**Qabul mezonlari**
- [ ] Migratsiya barcha modellarni yaratadi, `prisma validate` yashil
- [ ] Env yetishmasa ilova ishga tushmaydi va sababni aytadi
- [ ] `money.ts` va `order-state.ts` 100% unit test qamrovi (taqiqlangan o‘tishlar xato beradi)
- [ ] Xato konverti shartnomaga mos, `BigInt` JSONda string
- [ ] Logda sirlar redakt qilinishi testlangan

---

## 2 — Autentifikatsiya va bot asosi
**Vazifa:** Mini App `initData` auth; web OTP (bot orqali); refresh rotatsiya; bot: `/start`, til tanlash,
menu button, payload'lar (`ref_`, `login_`), outbox navbati; `User`/`Wallet` yaratish; referal bog‘lash.

**Qabul mezonlari**
- [ ] initData: to‘g‘ri / soxta / eskirgan testlari
- [ ] Web: start → botda kod → verify → cookie → `/me`; 5 urinish va muddat ishlaydi
- [ ] Bot uz/ru: `/start`, til almashtirish, snapshot testlar
- [ ] `ref_` payload faqat birinchi marta bog‘laydi, o‘zini taklif qilish rad etiladi

---

## 3 — Katalog va narx
**Vazifa:** kategoriyalar, mahsulotlar, SKU, `inputSchema`, seed (Stars, Premium); FX kurslari;
narx sinxronlash (Fragment narxi — dry-run simulyatordan); kotirovka endpointi; `fromPrice`.

**Qabul mezonlari**
- [ ] `GET /catalog/*` lokalga mos nomlar bilan
- [ ] Kotirovka: 10 daq muddat, foydalanuvchiga bog‘langan, `maxCost` hisoblangan
- [ ] Eski kurs bo‘lsa kotirovka berilmaydi (test)
- [ ] Yaxlitlash qoidalari testlangan

---

## 4 — Hamyon va to‘lovlar (birinchi provayder)
**Vazifa:** ledger, balans + kesh, `PaymentIntent`, birinchi provayder (Click **yoki** Payme — D-04),
callback'lar, TOPUP, reversal, `TOPUP_AND_BUY` asosi, bot xabari, solishtirish skeleti.

**Qabul mezonlari**
- [ ] Sandbox bilan to‘liq to‘ldirish oqimi ishlaydi
- [ ] Noto‘g‘ri imzo / summa / replay ×3 / bekor qilish testlari yashil
- [ ] Parallel callback'lar bitta TOPUP beradi
- [ ] `security-auditor` — to‘lov moduli bo‘yicha critical/high yo‘q

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
- [ ] Lighthouse ≥ 90 (Performance, SEO, Accessibility) uz va ru'da
- [ ] Sitemap va hreflang to‘g‘ri

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
- [ ] `security-auditor` — admin bo‘yicha critical/high yo‘q

---

## 10 — Referal, keshbek, chegirma va bonus kodlar, qolgan to‘lov usullari
**Vazifa:** referal bonus (DELIVERED'da), keshbek tangalar, chegirma tier'lari va kodlari, bonus kodlar,
rassilka, 2–4-to‘lov provayderlari (Payme/Click, Uzum, Rahmat), Telegram Stars to‘ldirish (D-03 ga qarab).

**Qabul mezonlari**
- [ ] Referal/keshbek faqat DELIVERED'da, admin qaytarishida bekor bo‘ladi
- [ ] Kodlar bir martalik, brute force rate limit
- [ ] Har yangi provayder 4-bosqich testlaridan o‘tgan

---

## 11 — Ishga tushirishga tayyorgarlik (MVP launch)
**Vazifa:** Railway production, monitoring va ogohlantirishlar, backup + restore sinovi, yuklama testi,
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
