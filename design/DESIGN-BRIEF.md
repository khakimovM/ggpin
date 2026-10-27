# Dizayn brief: Claude Design uchun promptlar

ggpin'ni to‘liq chizish uchun prompt to‘plami — FinTrack'dagi usulda.
Promptlar ingliz tilida (model yaxshiroq tushunadi), ekrandagi barcha matnlar o‘zbekcha;
oxirgi raundda ruscha variantlar tekshiriladi.

## Qanday foydalanish

1. Claude Design'da yangi loyiha oching. Promptlarni **tartib bilan** yuboring: 0 → 9, har biri alohida xabar.
   Natijani ko‘rib, kerak bo‘lsa tuzattiring, keyin keyingisiga o‘ting.
2. **Reference rasmlarni 0-prompt bilan birga** yuklang (8–12 ta), `design/references/` ga ham saqlang:
   - 3–4 ta Mini App / mobil do‘kon ekrani (o‘yin donat do‘konlari, fintech hamyon ilovalari);
   - 2 ta landing page;
   - 2 ta admin dashboard;
   - 1–2 ta qorong‘i mavzu namunasi;
   - @buypinbot skrinshotlari — **faqat funksiya** uchun, uslub uchun emas.
3. Har raunddan keyin tekshiring: 4 holat bormi (yuklanish, bo‘sh, xato, to‘ldirilgan); 390 px variant
   bormi; matnlar o‘zbekcha va to‘g‘rimi; o‘yin logotiplari o‘rnida neytral joy (placeholder) turibdimi.
4. Oxirida **Handoff** qiling va bundle'ni `design/handoff/` ga qo‘ying. Keyin Claude Code'da
   `/implement-design <ekran>` bilan quriladi.

**Eslatma — rasmlar:** o‘yin va Telegram logotiplari/muqovalari dizaynda chizilmaydi; ular uchun
neytral rasm joylari (rounded image slot + mahsulot nomi) qo‘yiladi. Haqiqiy rasmlar keyin ruxsat
etilgan manbalardan (ta'minotchi/rasmiy press-kit) qo‘yiladi.

---

## Prompt 0 — Master brief + design system

```text
You are designing a complete product for "ggpin", a digital top-up store for Uzbekistan. I will send the brief in rounds. This first message sets the product context and the rules every screen must follow, and asks for the design system. Each later message covers a group of screens; always reuse the design system from this round.

## Product
ggpin sells digital goods: Telegram Stars, Telegram Premium (3/6/12 months), and game top-ups (PUBG Mobile UC, Mobile Legends diamonds, Steam wallet and CS2, Roblox gift cards/Robux, Free Fire, Standoff 2, Discord Nitro and more). Users top up a wallet in Uzbek so‘m (UZS) with Click, Payme, Uzum or Rahmat, then buy from the wallet. Delivery is automatic and fast (usually 1–2 minutes). Channels: a Telegram bot + Telegram Mini App (main channel), a website (landing + full web store, sign-in via Telegram), and an admin panel for the owner and operators.

Users: Uzbek-speaking (and Russian-speaking) people aged 14–35, almost always on phones, heavy Telegram users and mobile gamers. They want: "fast, cheap, safe — and I can see exactly what is happening with my order". They fear: sending money and getting nothing, typing the wrong ID.

Brand personality: energetic, modern, trustworthy. A mix of gaming energy and fintech clarity. Confident, not childish. No casino/gambling look, no neon overload, no fake urgency. The name "ggpin" starts with "gg", gamer slang for "good game": let that show lightly, never as a gimmick. The wordmark is always lowercase "ggpin". Propose a simple logo: a wordmark plus a compact mark that works as a 32px favicon and as the Telegram bot avatar; the compact mark may play with the double "g".

## References
I am attaching reference images. Take the visual language from them (density, colour mood, typography feel, card style, motion). Take functionality only from this brief. If a reference conflicts with the brief, the brief wins. Do not copy logos, brand names or illustrations from the references. Do not draw game or Telegram logos or game art: use neutral rounded image slots with the product name; real images will be added later.

## Technical constraints (the design will be implemented exactly)
- Next.js + React + Tailwind CSS (web and Mini App), React + Tailwind (admin). Every colour is a semantic token (CSS variable) with light and dark values. No one-off hex colours inside screens.
- Components hand-built in the shadcn/ui style. Icons: lucide only.
- Motion is important to the brand: define durations and easings for page transitions, bottom sheets, selection, success moments and skeleton shimmer. Everything must have a reduced-motion fallback.
- One Google Font family with Latin Extended AND Cyrillic support (Uzbek uses o‘, g‘, ʼ; Russian uses Cyrillic), optionally a second for numbers. Tabular figures for money.
- Frames: Mini App 390 (primary), web desktop 1440, tablet 768. Everything works at 375 wide with no horizontal scroll.
- Telegram Mini App: runs inside Telegram's webview — no browser bar; respect safe-area insets; light/dark follows Telegram's colour scheme (our own brand palette, not Telegram's colours); Telegram's native Back button is used (no in-app back arrow in the Mini App); the primary action of a screen can be Telegram's native bottom MainButton — design our own bottom action bar that visually matches it.
- Charts in the admin must be drawable with Recharts (area, line, bar, donut).

## Display rules
- Money: "12 550 so‘m" — space as thousands separator, no decimals for so‘m. Russian: "12 550 сум".
- Stars: "500 ⭐". Premium durations: "3 oylik", "6 oylik", "12 oylik".
- Dates: "15-noyabr, 14:05", relative "Bugun", "Kecha". Never raw ISO dates.
- Order statuses (always icon + colour + text, never colour alone): "Navbatda" (neutral), "Bajarilmoqda" (info, animated), "Tekshirilmoqda" (warning), "Yetkazildi" (success), "Bajarilmadi — pul qaytarildi" (danger), "Bekor qilindi" (muted).
- Product badges: region "Global" / "SNG" / "UZ"; delivery "⚡ Avto" (instant API) or "🎟 Promokod" (code delivered); "Mashhur" (popular); "Tugagan" (out of stock).
- Accessibility: WCAG AA in both themes, touch targets ≥ 44px, visible focus, reduced motion.
- Every data view has four designed states: loading (skeleton shaped like the final layout), error (short message + "Qayta urinish"), empty (icon or small illustration + one line + primary action), filled.
- All UI copy is Uzbek (Latin). Use exact strings I give in quotes, keep apostrophes as written (o‘, g‘, ʼ). Where I give no copy, write short, plain, friendly Uzbek. Leave ~30% extra width in buttons and labels: Russian strings are longer.

## Sample data (use on every screen)
- User: "Sardor Rahimov", @sardor_r, ID 1187712645, wallet 85 400 so‘m, cashback 120 tanga.
- Catalog: Telegram Stars (1 ⭐ = 220 so‘m, min 50), Telegram Premium (3 oylik 165 000 so‘m, 6 oylik 220 000 so‘m, 12 oylik 396 000 so‘m), PUBG Mobile (60 UC 12 150 so‘m, 325 UC 61 500 so‘m, 660 UC 120 750 so‘m, 1800 UC 299 150 so‘m), Mobile Legends (86 olmos 19 900 so‘m), Steam (balans, 50 000 so‘m dan), Roblox $10 karta 122 450 so‘m (69 ta qoldi), Roblox $3 karta (Tugagan), Free Fire, Standoff 2, Discord Nitro.
- Recent orders: #10482 500 ⭐ → @dilnoza_k (Yetkazildi, Bugun 14:05); #10479 Premium 3 oylik → @jasur_t (Bajarilmoqda); #10470 PUBG 660 UC → ID 5123456789 (Bajarilmadi — pul qaytarildi).
- Referral: 7 do‘st taklif qilingan, 18 300 so‘m bonus.

## Information architecture
Mini App bottom navigation: "Bosh sahifa" · "Tarix" · "Profil" (plus a floating wallet chip on Home). Web store: top navigation "Katalog", "Tarix", "Profil", wallet chip, language switch "UZ / RU", "Kirish".

## Deliverable for this round: the design system board (light and dark)
1. Tokens: background, surface, card, elevated, border, input, ring, text (primary, secondary, muted), primary (+hover, +foreground), accent, success, warning, danger, info, plus domain tokens: status-queued, status-processing, status-review, status-delivered, status-failed, star (for Stars), premium, and chart-1…chart-8.
2. Typography scale (display, h1–h4, body, small, caption, numeric styles incl. large balance numbers), spacing, radius, shadows/elevation, motion tokens (durations, easings, spring presets) with reduced-motion fallbacks.
3. Components with states (default, hover, pressed, focus, disabled, loading, error):
   Button (primary, secondary, outline, ghost, destructive, link; sm/md/lg/icon) · Bottom action bar (MainButton look) · Input with label/help/error · Username input with "@" prefix · Player ID input (digits) + optional Zone ID · MoneyInput ("so‘m" suffix, live grouping) · Quantity stepper with quick chips · Segmented control · Tabs · Chip / filter chip · Badge (region, delivery, popular, out of stock) · Status chip (6 order statuses) · Product card (image slot, name, badges, "dan boshlab" price) · SKU tile (amount, price, selected state, "Eng foydali" ribbon, disabled "Tugagan") · Recipient card (avatar, name, @username, "Tasdiqlash" / "O‘zgartirish") · Wallet card · Payment method tile · Order row · Order timeline (vertical, animated current step) · Bottom sheet with drag handle (mobile) ↔ modal (desktop) · Confirm dialog · Toast (success, error, warning, info) · Skeletons · Empty state · Error state · Avatar · Copy-to-clipboard field · Accordion (FAQ) · Language switch (UZ / RU) · Stepper/progress · Data table + mobile card row (admin) · KPI card (admin) · Sidebar nav (admin).
Keep the board practical: a developer will map it one-to-one to Tailwind tokens.
```

---

## Prompt 1 — Landing, login, tizim sahifalari (web)

```text
Round 1. Use the ggpin design system from round 0. Design at 1440 and 390, light and dark for the landing hero and login.

### 1. Landing "/" — fast to scan, SEO-friendly (it will be server-rendered)
- Header: logo; links "Mahsulotlar", "Qanday ishlaydi", "Savollar"; language switch "UZ / RU"; buttons "Kirish" and primary "Telegram’da ochish". Mobile: links in a menu.
- Hero: headline and sub-headline around "Telegram Stars, Premium va o‘yin donatlari — bir necha daqiqada". Primary CTA "Telegram’da ochish" (opens the bot Mini App), secondary "Saytda xarid qilish" (web store). Trust line: "⚡ 1–2 daqiqada yetkaziladi · 🔒 Xavfsiz to‘lov · 💸 Bajarilmasa — pul qaytadi". Visual: a phone showing the Mini App home screen, with small floating cards animating in ("500 ⭐ yetkazildi", "Premium 3 oylik", "660 UC") — tasteful, not noisy.
- "Mahsulotlar": a grid of product cards (Telegram Stars, Telegram Premium, PUBG Mobile, Mobile Legends, Steam, Roblox, Free Fire, Standoff 2) with "dan boshlab" prices and "Tez orada" badges for games not yet live.
- "Qanday ishlaydi": 3 steps — 1) "Hisobni to‘ldiring" (Click, Payme, Uzum, Rahmat); 2) "Mahsulotni tanlang va username yoki ID kiriting"; 3) "Bir necha daqiqada oling — holatini jonli kuzating".
- Payment methods strip (neutral logo slots with names).
- "Nega biz?": four cards — "Avtomatik yetkazish", "Shaffof holat", "Pul qaytarish kafolati", "O‘zbek va rus tilida yordam".
- Referral band: "Do‘stlaringizni taklif qiling — har bir xariddan 1% bonus".
- "Savollar": FAQ accordion — "Qancha vaqtda yetkaziladi?", "Username’ni noto‘g‘ri yozsam nima bo‘ladi?" (biz tasdiqlash uchun ism va rasmni ko‘rsatamiz), "Buyurtma bajarilmasa pulim nima bo‘ladi?" (avtomatik balansga qaytadi), "Qaysi to‘lov usullari bor?", "Telegram Premium sovg‘a qilsam bo‘ladimi?".
- Final CTA band; footer: "© 2026 ggpin", links "Ommaviy oferta", "Maxfiylik siyosati", "Aloqa", Telegram channel, bot.
Do not invent user counts, ratings or testimonials.

### 2. Product SEO page "/telegram-stars" (template reused for every product)
Hero with product name, short description, price table (Stars: 50/100/250/500/1000 with prices), "Sotib olish" CTA, how-to steps, product FAQ, related products.

### 3. Login "/login"
Centred card, logo, link back to landing. Title "ggpin’ga kirish". Text "Parol kerak emas: kirish kodi Telegram’dagi botimizga keladi. Birinchi marta kirsangiz, hisob avtomatik yaratiladi." Footer note with shield icon: "Kodni hech kimga bermang — xodimlarimiz uni hech qachon so‘ramaydi." States:
a) Start: big button "Telegram orqali kirish" (+ loading).
b) Waiting: steps "1. Telegram’da botimiz ochiladi.", "2. Start tugmasini bosing.", "3. Bot yuborgan 6 xonali kodni shu yerga kiriting."; outline button "Telegram’ni ochish"; spinner "Telegram’dan javob kutilmoqda…".
c) Code sent: "Kod Telegram’ga yuborildi", 6-box OTP (auto-submit, paste), "Tasdiqlash", countdown "Kod 2:41 amal qiladi", "Kodni qayta yuborish" with cooldown.
d) Wrong code "Kod noto‘g‘ri. Yana 3 ta urinish qoldi". e) Expired "Kod muddati tugadi". f) "So‘rov Telegram’da rad etildi." + "Qaytadan boshlash". g) Error banner "Telegram orqali kirish vaqtincha ishlamayapti".

### 4. System pages
404 "Sahifa topilmadi"; error page "Xatolik yuz berdi" with "Sahifani yangilash"; payment return page "/pay/…" with three states: "To‘lov tekshirilmoqda…" (spinner), "To‘lov qabul qilindi — balansingiz 50 000 so‘mga to‘ldirildi" (+ "Do‘konga qaytish"), "To‘lov amalga oshmadi" (+ "Qayta urinish").
```

---

## Prompt 2 — Mini App: qobiq, kirish, bosh sahifa

```text
Round 2. Use the design system. Telegram Mini App at 390, light and dark (Telegram colour scheme decides which).

### 1. Splash and gates
- Splash while signing in with Telegram: logo + subtle progress.
- Gate screens (icon, title, body, one button): "Ilovani bot orqali oching" / "Iltimos, ilovani botdagi “Xaridni boshlash” tugmasi orqali oching." / "Botga qaytish"; "Hisobingiz bloklangan" / "Savollar bo‘lsa, yordam xizmatiga yozing." / "Yordam"; "Ulanib bo‘lmadi" / "Internet aloqasini tekshirib, qayta urinib ko‘ring." / "Qayta urinish".
- First launch language picker (bilingual, always shown in both languages): "Tilni tanlang · Выберите язык" with "O‘zbekcha" and "Русский".

### 2. Shell
Bottom navigation "Bosh sahifa", "Tarix", "Profil" respecting the safe area. No in-app back arrow (Telegram Back button). Toast placement above the bottom nav.

### 3. Home "Bosh sahifa" — the most important screen; make it beautiful and fast
- Top row: avatar, "Sardor", "@sardor_r", cashback chip "🪙 120".
- Wallet card (hero): "Balans" 85 400 so‘m (large numeric style), actions "Hisobni to‘ldirish" (primary), "Bonus kod", "Yordam". Subtle animated background on the card (respect reduced motion).
- Search "Mahsulot qidirish…" and category chips "Hammasi", "Telegram", "O‘yinlar", "Platformalar".
- "Telegram" section: two large feature cards — "Telegram Stars" ("1 ⭐ = 220 so‘m") and "Telegram Premium" ("165 000 so‘m dan").
- "O‘yinlar" grid (2 columns): product cards with image slot, name, region badge, "⚡ Avto" / "🎟 Promokod", "Mashhur" star, "Tez orada" for not-yet-live games (disabled look).
- Optional promo banner slot (carousel, dots) for admin-managed announcements.
- States: skeleton home; catalog error inside its section with "Qayta urinish"; search empty "Hech narsa topilmadi" + "Qidiruvni tozalash"; offline banner.
```

---

## Prompt 3 — Mahsulot sahifalari (4 xil yetkazish turi)

```text
Round 3. Use the design system and Mini App shell. Design at 390 (Mini App) — light and dark. Every product page shares one template: header card (image slot, name, subtitle, badges), the recipient block, the package block, the price summary, and a bottom action bar "Sotib olish · 22 000 so‘m".

### A. Telegram Stars (username + custom quantity)
- Recipient block "Kimga yuboramiz?": "@username" input, helper "O‘zingizga yoki do‘stingizga", quick chip "O‘zimga" (fills own username), button "Tekshirish".
- Recipient states: checking (skeleton card); found → recipient card with avatar, "Dilnoza K.", "@dilnoza_k", and text "To‘g‘ri odammi? Tasdiqlang", buttons "Ha, shu" / "O‘zgartirish"; not found "Bunday foydalanuvchi topilmadi. Username’ni tekshiring."; invalid format "Username 5–32 ta lotin harf, raqam yoki _ dan iborat bo‘ladi"; service unavailable "Tekshirish vaqtincha ishlamayapti. Birozdan so‘ng urinib ko‘ring."
- Package block: quantity input with stepper and quick chips 50 / 100 / 250 / 500 / 1000 / 2500; live price "500 ⭐ = 110 000 so‘m"; helper "1 ⭐ = 220 so‘m · Minimal: 50 ⭐"; error "Kamida 50 ⭐ tanlang".
- Bottom bar disabled until the recipient is confirmed (show the disabled state with hint "Avval qabul qiluvchini tasdiqlang").

### B. Telegram Premium (username + plan)
- Same recipient block; plan tiles "3 oylik 165 000 so‘m", "6 oylik 220 000 so‘m" (ribbon "Eng foydali"), "12 oylik 396 000 so‘m" (show monthly equivalent "33 000 so‘m/oy").
- Recipient already has Premium: warning card "Bu foydalanuvchida Premium allaqachon bor. Sovg‘a muddatni uzaytiradi." (design a variant where purchase is blocked instead: "Bu foydalanuvchiga hozir Premium sovg‘a qilib bo‘lmaydi").

### C. PUBG Mobile (player ID + package tabs) — template for GAME_ID products
- "Player ID" input (digits) with an info icon opening a bottom sheet "ID’ni qayerdan topaman?" (3 numbered steps with image slots), button "Tekshirish" → recipient card with game nickname "SardorPRO" and region.
- Tabs "UC tezkor" / "To‘plamlar"; SKU grid (2 columns): 60 UC 12 150 so‘m, 120 UC, 180 UC, 325 UC, 385 UC, 660 UC, 985 UC, 1320 UC, 1800 UC, 2460 UC, 3850 UC, 8100 UC; selected state; "Eng foydali" ribbon on one.
- Mobile Legends variant: two inputs side by side "User ID" and "Zone ID" (format hint "12345678 (1234)"), and a region warning "Faqat Global serverdagi akkauntlar uchun".

### D. Steam (login + amount) — STEAM_LOGIN template
- "Steam login" input (not nickname) with help sheet "Loginni qayerdan topaman?"; check → profile card (avatar, profile name, "Hisob regioni: MDH").
- Amount: MoneyInput in so‘m with quick chips 50 000 / 100 000 / 200 000 / 500 000; line "Steam hisobingizga taxminan 3,85 $ tushadi" and fee note "Xizmat haqi narxga kiritilgan".
- Warning: "Login noto‘g‘ri bo‘lsa, pul boshqa hisobga tushadi va qaytarib bo‘lmaydi."
- CS2 card on the catalog links here with a CS2 header variant.

### E. Roblox gift card (voucher) — VOUCHER template
- No recipient input. Description "Kodni roblox.com/redeem sahifasida faollashtirasiz — balansga $ tushadi".
- SKU rows with stock chips: "Roblox $3 — Tugagan" (disabled), "Roblox $10 — 122 450 so‘m — 69 ta", "Roblox $15 — 191 715 so‘m — 25 ta".

### States for every product page
Skeleton page; product unavailable "Mahsulot vaqtincha mavjud emas"; price loading inside the bottom bar; error with retry.
```

---

## Prompt 4 — Xarid, to‘ldirish, buyurtma holati

```text
Round 4. Use the design system. Mini App at 390, light and dark.

### 1. Confirm sheet (after "Sotib olish")
Bottom sheet: product line ("Telegram Stars · 500 ⭐"), recipient ("@dilnoza_k · Dilnoza K."), price, discount code field "Chegirma kodi" (+ applied state "−1% · −1 100 so‘m"), total, "Balans: 85 400 so‘m → 31 300 so‘m", price validity "Narx 9:41 daqiqa amal qiladi", primary "To‘lash" (loading state). Expired quote state: "Narx yangilandi: 110 500 so‘m" + "Yangi narx bilan davom etish".

### 2. Insufficient balance sheet
Icon, title "Mablag‘ yetarli emas", lines "Balansingiz: 85 400 so‘m", "Narx: 122 450 so‘m", "Yetishmaydi: 37 050 so‘m" (danger). Primary "37 050 so‘m to‘ldirish va sotib olish", secondary "Boshqa summa bilan to‘ldirish", ghost "Yopish".

### 3. Top-up flow "Hisobni to‘ldirish"
- Step 1 — method grid: Click, Payme, Uzum, Rahmat (neutral logo slots + names), optional "Telegram Stars". Link card "Qo‘llanma — qanday to‘ldiraman?".
- Step 2 — amount: selected method summary with "O‘zgartirish", MoneyInput "Summa", quick chips 20 000 / 50 000 / 100 000 / 200 000, helper "Minimal: 5 000 so‘m", errors "Minimal summa 5 000 so‘m", "Maksimal summa 10 000 000 so‘m"; primary "Davom etish".
- Step 3 — handoff to the payment page: "To‘lov sahifasiga o‘tilmoqda…" with a note "To‘lovdan so‘ng shu yerga qayting".
- Step 4 — result: waiting "To‘lov tekshirilmoqda…"; success "Balans to‘ldirildi! +50 000 so‘m" with confetti moment (reduced-motion: simple check); failed "To‘lov amalga oshmadi" + "Qayta urinish"; for TOPUP_AND_BUY: success leads straight into the order status screen.

### 4. Order status screen (live)
- Header: product image slot, "Telegram Stars · 500 ⭐", "#10482", recipient.
- Vertical timeline with animated current step: "To‘landi" → "Navbatda" → "Bajarilmoqda" → "Yetkazildi". Show times for done steps.
- Design every terminal/side state:
  • Delivered: big success state "Yetkazildi! 🎉", "@dilnoza_k hisobiga 500 ⭐ tushdi", buttons "Yana xarid qilish", "Ulashish".
  • Voucher delivered: code field with "Nusxalash" and "Faollashtirish yo‘riqnomasi"; warning "Kodni hech kimga ko‘rsatmang".
  • Under review: "Tekshirilmoqda" with text "Buyurtmangiz qo‘lda tekshirilmoqda. Odatda 15 daqiqagacha. Pulingiz xavfsiz." and "Yordamga yozish".
  • Failed: "Bajarilmadi", "122 450 so‘m balansingizga qaytarildi", reason line, buttons "Qayta urinish", "Yordam".
  • Cancelled by admin.
- The user can leave; a small persistent "1 ta buyurtma bajarilmoqda" pill appears on Home until it completes.
```

---

## Prompt 5 — Tarix, profil, referal, kodlar, yordam

```text
Round 5. Use the design system. Mini App at 390, light and dark.

### 1. "Tarix"
Tabs "Buyurtmalar" / "Moliya".
- Orders: filter chips "Barchasi", "Bajarildi", "Kutilmoqda", "Bekor qilingan"; rows with product image slot, title, recipient, amount, status chip, relative date; grouped by day. Tap → order status screen (round 4).
- Finance: rows for "Balans to‘ldirildi (Payme)" +50 000, "Xarid #10482" −110 000, "Pul qaytarildi #10470" +120 750, "Referal bonus" +1 100, "Bonus kod" +5 000; signs and colours; grouped by day.
- States: skeleton; error; empty orders "Hali buyurtmalar yo‘q" + "Xaridni boshlash"; empty finance "Hali amallar yo‘q".

### 2. "Profil"
- Profile card: avatar, name, @username, "ID: 1187712645" with copy, mini stats "Balans 85 400 so‘m", "Keshbek 120 🪙".
- "Telefon raqami": "Telefon raqamini ulashish" (Telegram contact request) and linked state "+998 90 *** ** 67".
- "Til": segmented "O‘zbekcha" / "Русский".
- "Xizmatlar" list: "Do‘stlarni taklif qilish" (sub "Har bir xariddan 1% bonus"), "Chegirma kodlari" (sub "Keshbekni chegirmaga aylantiring"), "Bonus kod kiritish", "Yordam va savollar".
- "Sozlamalar": switch "Animatsiyalarni kamaytirish" (sub "Eski qurilmalarda tezroq ishlashi uchun").
- Footer links "Ommaviy oferta", "Maxfiylik siyosati", app version.

### 3. "Do‘stlarni taklif qilish"
Hero illustration slot, text "Do‘stlaringiz xarid qilganda har bir to‘lovdan 1% bonus olasiz". Referral link field (t.me/ggpin_bot/app?startapp=ref_SARDOR7) with "Nusxalash" and primary "Ulashish". Stats "Taklif qilinganlar: 7", "Jami bonus: 18 300 so‘m". List of invited friends (avatar, name, joined date, earned). Empty state "Hali hech kim taklif qilinmadi".

### 4. "Chegirma kodlari"
Coins balance card "Sizning keshbekingiz: 120 🪙". Tier cards: "0,2% chegirma — 15 🪙", "0,5% — 35 🪙", "1% — 70 🪙", "1,5% — 90 🪙" (disabled when not enough coins, with "Yetarli emas"). Confirm sheet "70 🪙 evaziga 1% chegirma kodi olinsinmi?". "Mening kodlarim": code chips with copy, "Ishlatilgan" state. Empty "Hali kod yo‘q".

### 5. "Bonus kod"
Single input "KODNI KIRITING" (auto-uppercase), "Faollashtirish"; success "+5 000 so‘m balansingizga qo‘shildi"; errors "Kod noto‘g‘ri", "Kod muddati tugagan", "Bu kodni allaqachon ishlatgansiz".

### 6. "Yordam"
FAQ accordion (5–7 questions) and a card "Savolingiz qoldimi?" with "Operatorga yozish" (opens chat with support) and working hours "Har kuni 09:00–23:00".
```

---

## Prompt 6 — Web do‘kon (desktop)

```text
Round 6. Use the design system. The web store for desktop 1440 and tablet 768 — the same functionality as the Mini App, laid out for large screens, light and dark.

- Top navigation: logo, "Katalog", "Tarix", "Profil", search, wallet chip "85 400 so‘m" with "+" (top up), language "UZ / RU", theme toggle, avatar menu ("Profil", "Chiqish").
- Catalog page: left category list, product grid (4 columns), promo banner.
- Product page: two columns — left: product header, description, "ID’ni qayerdan topaman?" section, FAQ; right: sticky purchase panel (recipient block, packages, price summary, "Sotib olish").
- Checkout and insufficient balance as centred modals; top-up as a modal with steps.
- Order status as a page with the timeline and a side panel "Buyurtma tafsilotlari".
- History: a table (date, product, recipient, amount, status) with filters and pagination ("Jami 48 tadan 1–20").
- Profile: cards in a 2-column layout (profile, language, referral summary, discount codes, bonus code, sessions "Faol sessiyalar" with "Yakunlash").
```

---

## Prompt 7 — Admin panel (1-qism)

```text
Round 7. Use the design system with a denser "admin" density variant. Desktop 1440 (and a usable 768). Admin UI language is Uzbek. Light and dark.

### 1. Admin login "/login"
Card "Admin panel", button "Telegram orqali kirish" → OTP flow (same states as the web login) with a warning "Faqat ruxsat berilgan xodimlar kira oladi".

### 2. Shell
Left sidebar groups: "Asosiy": "Dashboard", "Buyurtmalar", "Tekshiruv navbati" (badge 3), "Foydalanuvchilar"; "Katalog": "Mahsulotlar", "Narx va sozlamalar", "Voucherlar"; "Moliya": "To‘lovlar", "Solishtirish"; "Infratuzilma": "Hamyon (TON)", "Fragment sessiyasi", "Ta’minotchilar", "Navbatlar"; "Marketing": "Bonus kodlar", "Rassilka", "Referallar"; "Tizim": "Audit log", "Adminlar". Header: global search ("# buyurtma, @username, tx hash"), environment chip ("PRODUCTION" red / "STAGING" amber), alert bell, admin card with role chip ("OWNER" / "OPERATOR" / "SUPPORT").

### 3. Dashboard
- Period filter "Bugun", "7 kun", "30 kun", "Oraliq".
- KPI cards: "Aylanma" 48 200 000 so‘m, "Yalpi foyda" 4 900 000 so‘m, "Buyurtmalar" 1 284, "Yetkazish ulushi" 99,4%, "O‘rtacha yetkazish" 1 daq 12 s, "Yangi foydalanuvchilar" 312, "To‘ldirishlar" 51 700 000 so‘m.
- Charts: turnover vs profit (area), orders by product (donut), payments by method (bar), deliveries per hour (bar).
- Alerts panel (top, prominent): "3 ta buyurtma tekshiruvda", "Hamyon balansi: 182 TON — kunlik limitning 64% ishlatildi", "Fragment sessiyasi: faol · oxirgi tekshiruv 2 daq oldin", "Ta’minotchi balansi kam: 48 $", "Solishtirishda 1 ta farq".

### 4. Orders list
Table: "#", "Sana", "Foydalanuvchi", "Mahsulot", "Qabul qiluvchi", "Narx", "Tannarx", "Foyda", "Holat", "Adapter". Filters (status, product, adapter, date range, amount, search), saved views, CSV export. Row click → detail.

### 5. Order detail
- Header: "#10479 · Telegram Premium 3 oylik", status chip, actions by role: "Qayta urinish", "Yetkazildi deb belgilash", "Bajarilmadi va qaytarish", "Bekor qilish", "Izoh qo‘shish".
- Panels: Customer (link to user), Recipient, Money (price, discount, cost in TON with rate snapshot, profit), Timeline (OrderEvent list with actor), Fulfillment attempts (adapter, status, external ref with a link to a TON explorer, request/response JSON viewer with secrets redacted), Ledger entries.
- Action dialogs: each requires "Sabab" (reason); money actions above the threshold ask for a Telegram confirmation code; destructive styling; audit note "Bu amal audit logga yoziladi".

### 6. Review queue "Tekshiruv navbati"
Cards for NEEDS_REVIEW and HELD orders with the reason ("TON tranzaksiya tasdiqlanmadi", "Narx 4% oshdi", "Kunlik limit"), age timer, quick actions, and a checklist "Zanjirda tekshirildi?".
```

---

## Prompt 8 — Admin panel (2-qism)

```text
Round 8. Continue the admin panel.

### 1. Users
Table (ID, @username, til, ro‘yxatdan o‘tgan, oxirgi faollik, balans, xaridlar, referallar, holat). Detail page with tabs "Buyurtmalar", "Moliya", "To‘lovlar", "Referallar", "Kodlar"; actions "Bloklash", "Xaridni muzlatish", "Balansni tuzatish" (dialog: amount ±, reason, confirmation code), "Sessiyalarni tugatish", "Xabar yuborish".

### 2. Products and catalog editor
List with drag-to-reorder, active toggle, region and delivery badges. Product editor: names and descriptions in two language tabs "O‘zbekcha" / "Русский", help text, image upload slot, category, delivery type, input schema builder (field rows: key, type, label uz/ru, validation), SKU table (label uz/ru, quantity, supplier SKU, markup %, min margin, active), routing (adapter priority list with health dots). Live price preview panel: "Tannarx 0,96 $ × 12 650 → 12 144 so‘m · Ustama 15% → 13 966 so‘m".

### 3. Pricing & settings
Cards: "Referal foizi", "Keshbek foizi", "Chegirma darajalari" (table), "To‘ldirish chegaralari", "Narx toleransi", "Kurs manbalari" with the rate history chart (USDT/UZS, TON/USDT) and an "emergency manual rate" toggle.

### 4. Payments
Intents and payments table with provider, status, amount, provider txn id; detail drawer with redacted payload; "Solishtirish" page: daily report per provider with matched / missing / extra counts and a resolution action.

### 5. Infrastructure
- "Hamyon (TON)": address with copy, balances TON and USDT, daily limit usage bar, per-order limit, recent transactions list, low-balance threshold (OWNER-only edit).
- "Fragment sessiyasi": status card ACTIVE/DEAD, last check, uptime history strip, button "Sessiyani yangilash" (starts the re-login flow: "Telegram’da tasdiqlash so‘rovi yuborildi…").
- "Ta’minotchilar": cards with health, balance, last price sync, error rate.
- "Navbatlar": queue cards (waiting, active, failed) with "Qayta ishga tushirish".

### 6. Marketing
- Bonus codes: create form (reward type "Balansga" / "Tangalar", value, max uses, expiry), list with usage.
- Broadcast composer: text tabs uz / ru with Telegram-like preview, image, button, audience builder (hammasi / til / faol oxirgi N kun / xarid qilganlar), "O‘zimga test", "Yuborish", progress and report.
- Referrals: top inviters, suspicious activity flags.

### 7. Audit log and Admins
Audit table (vaqt, admin, amal, obyekt, sabab, IP) with a diff viewer. Admins page (OWNER only): list, add by Telegram ID + role, deactivate, active sessions.
```

---

## Prompt 9 — Bot vizuallari va yakuniy tekshiruv

```text
Round 9 (final).
1. Telegram bot assets: bot avatar (from the logo mark, 512×512), welcome banner image for /start (1280×720) with the headline "Stars, Premium va donatlar — bir necha daqiqada", a share card for referral links (1200×630), and product share cards (Stars, Premium).
2. Russian check: re-render these screens with Russian copy and fix overflow: Mini App home, Stars product, PUBG product, confirm sheet, insufficient balance sheet, order status, top-up amount, profile, landing hero, login. Russian samples: "Пополнить баланс", "Купить", "Недостаточно средств", "Доставлено", "Проверяется", "Не выполнено — деньги возвращены", "Пригласить друзей".
3. Consistency review against round 0: every screen has 390 (Mini App/web) and 1440 (web/admin) frames as applicable; dark versions of landing hero, login, Mini App home, product, order status, admin dashboard; consistent statuses, money formatting, no raw ISO dates, all four data states present; motion specs annotated for: wallet card, SKU selection, bottom sheets, timeline step change, success moment.
4. Finish with a component inventory and a token sheet (names, light/dark values, motion tokens) that maps one-to-one to Tailwind CSS variables. Then I will export the handoff.
```
