# 10 — Xavfsizlik modeli

## Nimani himoya qilamiz

| Aktiv | Nega muhim | Qayerda |
|---|---|---|
| TON hot wallet (mnemonic) | to‘g‘ridan-to‘g‘ri pul | faqat worker, shifrlangan |
| Fragment sessiyasi | Stars/Premium sotib olish huquqi | DB'da shifrlangan, faqat worker o‘qiydi |
| Ta'minotchi API kalitlari | ta'minotchidagi balansimiz | faqat worker env |
| To‘lov provayder kalitlari | soxta "to‘lov tasdiqlandi" | faqat api env |
| Foydalanuvchi balanslari | pul | ledger |
| Admin panel | hammasini boshqarish | allowlist + rol + audit |
| Bot tokeni | bot nomidan xabar, initData imzosi | faqat api env |

## Tahdidlar va himoya

| Tahdid | Himoya |
|---|---|
| Soxta to‘lov callback'i | provayder imzosi/Basic auth, aniq summa, intent holati, IP allowlist, idempotentlik |
| Callback qayta yuborish (replay) | `(provider, providerTxnId)` unique, saqlangan javobni qaytarish |
| Bitta balans bilan ikki parallel xarid | hamyon qatori qulfi (`FOR UPDATE`) + tranzaksiya |
| Buyurtma ikki marta yetkazilishi | `jobId=orderId`, order lock, `FulfillmentAttempt` tekshiruvi, noma'lum → NEEDS_REVIEW |
| Narx manipulyatsiyasi (eski kotirovka) | kotirovka foydalanuvchiga bog‘langan, 10 daq, bir martalik (`usedAt`) |
| Kurs/narx keskin o‘zgarishi | `maxCost` chegarasi → HELD; eski kurs bilan kotirovka berilmaydi |
| initData soxtalashtirish | HMAC tekshiruvi, `auth_date` muddati, timingSafeEqual |
| OTP brute force | 5 urinish, 3 daqiqa, rate limit, nonce bir martalik |
| Admin akkaunti o‘g‘irlanishi | allowlist + rol, qisqa sessiya, katta pul amallarida qo‘shimcha kod, audit, egaga har kirish haqida xabar |
| API buzilishi → hamyon | sirlar faqat worker'da, worker'ning tashqi porti yo‘q, API env'da worker sirlari bo‘lsa ishga tushmaydi |
| Hot wallet to‘liq o‘g‘irlanishi | issiq hamyonda faqat 1–3 kunlik summa, kunlik limit, sovuq zaxira serverdan tashqarida |
| Referal farming | o‘zini taklif qilish yo‘q, bonus faqat DELIVERED'dan, kunlik cheklov, shubhali naqshlar admin'da |
| Bonus kod brute force | rate limit, hash bilan saqlash, uzun tasodifiy kodlar |
| XSS (mahsulot nomi, username) | React escape, bot HTML escape, CSP |
| SSRF (foydalanuvchi kiritgan maydon URL'ga tushishi) | input sxema regex'lari, ta'minotchi URL'lari qat'iy, foydalanuvchi maydoni faqat body'da |
| Sirlar git'ga tushishi | `.gitignore`, gitleaks (CI + pre-commit), Claude hook'lari |
| Bog‘liqlik zaifliklari | `npm audit`, Dependabot, versiyalarni qotirish |
| Fragment/TON ichki API o‘zgarishi | Zod bilan javob tekshiruvi, adapter DOWN → zaxira, ogohlantirish |

## Claude Code darajasidagi himoya (ishlab chiqish paytida)

- `.claude/hooks/guard-bash.mjs` — xavfli buyruqlar, sirlarni chiqarish, dry-run'ni o‘chirish,
  Fragment/TON yuborish endpointlariga to‘g‘ridan-to‘g‘ri murojaat **bloklanadi**.
- `.claude/hooks/guard-files.mjs` — `.env`, kalit fayllarini o‘qish/yozish va kodga mnemonic,
  bot tokeni, cookie, kalit yozish **bloklanadi**.
- `.claude/settings.json` — `permissions.deny` (env fayllar, `migrate reset`, force push),
  standart `FULFILLMENT_DRY_RUN=true`.
- Pluginlar: `security-guidance` (tahrirlarda ogohlantirish + diff review), `claude-security`
  (chuqur zaiflik skaneri), `code-review`, `pr-review-toolkit`.
- Subagentlar: `security-auditor` (faqat o‘qiydi), `code-reviewer` (faqat o‘qiydi).

## Ishga tushirishdan oldingi tekshiruv ro‘yxati

- [ ] `security-auditor` — "ok" yoki "ok with fixes" (critical/high yo‘q)
- [ ] `/security-check all` + `claude-security` skaneri natijalari ko‘rib chiqilgan
- [ ] gitleaks toza, `npm audit --omit=dev` da high/critical yo‘q
- [ ] Hot wallet limitlari production qiymatlarida, sovuq hamyon alohida
- [ ] Barcha provayder sandbox testlari o‘tgan, production kalitlari faqat Railway'da
- [ ] Admin: faqat kerakli ID'lar, OWNER bitta
- [ ] Backup va restore sinab ko‘rilgan
- [ ] Ogohlantirishlar egaga yetib kelishi sinalgan
- [ ] Ommaviy oferta, maxfiylik siyosati, qaytarish qoidalari sahifalari bor (yurist bilan)
