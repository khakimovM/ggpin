# 08 — Frontend spetsifikatsiyasi

Vizual manba — Claude Design handoff (`design/handoff/`). Bu fayl **funksiya va holatlarni** belgilaydi.
Dizayn promptlari: `design/DESIGN-BRIEF.md`.

## Ilovalar va marshrutlar

### apps/web (Next.js)

| Marshrut | Sahifa | Render |
|---|---|---|
| `/[locale]` | Landing | SSG/ISR, SEO |
| `/[locale]/telegram-stars`, `/[locale]/telegram-premium`, `/[locale]/pubg-mobile-uc` ... | Mahsulot landing sahifalari (SEO) + "Sotib olish" | ISR |
| `/[locale]/faq`, `/[locale]/terms`, `/[locale]/privacy`, `/[locale]/contacts` | Statik sahifalar | SSG |
| `/[locale]/login` | Telegram orqali kirish (OTP) | client |
| `/[locale]/store/...` | Web do‘kon (Mini App bilan bir xil funksiya, desktop layout) | client |
| `/pay/[intentId]` | To‘lov natijasi / provayderga yo‘naltirish | client |
| `/tg/...` | Telegram Mini App | client, locale profildan |

`locale` = `uz` (standart, prefikssiz ham ochiladi) yoki `ru`. `hreflang`, `sitemap.xml`, `robots.txt`.

### Mini App ekranlari (`/tg`)

| Ekran | Asosiy elementlar |
|---|---|
| Splash / kirish | logo, initData bilan avtomatik kirish; xato holatlari |
| Bosh sahifa | profil qatori (avatar, ism, keshbek tangalari), balans kartasi (to‘ldirish, bonus kod, yordam), kategoriya chiplari, qidiruv, mahsulot grid'i |
| Mahsulot | sarlavha kartasi, input forma (`inputSchema` bo‘yicha), "Tekshirish" → qabul qiluvchi kartasi, SKU tab'lari va grid'i yoki erkin miqdor + jonli narx, "Qanday topaman?" sheet, MainButton "Sotib olish" |
| Tasdiqlash sheet | mahsulot, qabul qiluvchi, narx, chegirma kodi, jami, balans, "To‘lash" |
| Mablag‘ yetarli emas | balans / narx / yetishmaydi; "{shortfall} to‘ldirish va sotib olish", "Hisobni to‘ldirish", "Yopish" |
| Buyurtma holati | jonli timeline (To‘landi → Navbatda → Bajarilmoqda → Yetkazildi), animatsiya, voucher kodi + Nusxalash, "Yana xarid qilish" |
| To‘ldirish | usullar grid'i (Click, Payme, Uzum, Rahmat, Stars), qo‘llanma, summa + tez summalar, "Davom etish" → tashqi to‘lov, natija |
| Tarix | "Buyurtmalar" / "Moliya" tab'lari, holat filtrlari, ro‘yxat, tafsilot |
| Profil / Sozlamalar | ID, balans, keshbek; telefon ulashish; til (O‘zbekcha / Русский); xizmatlar: do‘stlarni taklif qilish, chegirma kodlari, yordam; animatsiyalarni kamaytirish |
| Referal | havola (nusxalash, ulashish — `switchInlineQuery`/share), statistik, taklif qilinganlar |
| Chegirma kodlari | tanga balansi, tier kartalari, "Mening kodlarim" |
| Bonus kod | kod kiritish, faollashtirish |
| Yordam | FAQ akkordeon, operatorga yozish |

### apps/admin — `docs/09-ADMIN-PANEL.md`

## Har bir ma'lumot ko‘rinishi uchun 4 holat

Skeleton (yakuniy layout shaklida) · Xato + "Qayta urinish" · Bo‘sh + harakat · To‘ldirilgan.

## Ko‘rsatish qoidalari

- Pul: "12 550 so‘m" / "12 550 сум"; probel bilan minglik; kasr faqat noldan farqli bo‘lsa.
- Stars: "500 ⭐"; Premium: "3 oylik" / "3 месяца".
- Sana: "15-noyabr, 14:05" / "15 ноября, 14:05"; "Bugun" / "Сегодня".
- Holat chiplari: Yetkazildi (yashil), Bajarilmoqda (ko‘k, animatsiya), Tekshirilmoqda (sariq),
  Bajarilmadi — pul qaytarildi (qizil), Bekor qilindi (kulrang).
- Narx har doim serverdan; "dan boshlab" narxlar katalogda taxminiy ekanligi ko‘rinib turadi.

## Telegram Mini App integratsiyasi

`ready()`, `expand()`, `themeParams` → CSS o‘zgaruvchilari, safe area, BackButton (ichki sahifalarda),
MainButton (asosiy harakat), `HapticFeedback` (muvaffaqiyat/xato), `openLink` (to‘lov sahifasi),
`shareMessage`/havola ulashish (referal), `requestContact` (telefon). Telegram yorug‘/qorong‘i mavzusi
avtomatik.

## Holat boshqaruvi

- Server ma'lumoti — TanStack Query; kalitlar `query-keys.ts`.
- Buyurtma tafsiloti terminal holatgacha har 2 s polling (yoki SSE).
- Xarid mutatsiyasi → `wallet` va `orders` invalidatsiya.
- Zustand: tanlangan SKU, ochiq sheet'lar, UI sozlamalari.

## Ishlash tezligi

- Mini App bosh sahifasi: birinchi ekran < 1 s (4G), rasmlar `next/image` (webp/avif), katalog keshlanadi.
- Landing: Lighthouse ≥ 90 (Performance, SEO, Accessibility).

## Animatsiyalar

Framer Motion: sahifa o‘tishlari, sheet'lar, SKU tanlash, buyurtma timeline'i, muvaffaqiyat konfettisi
(qisqa), skeleton shimmer. `prefers-reduced-motion` va profildagi "Animatsiyalarni kamaytirish"
ikkalasi ham hurmat qilinadi.
