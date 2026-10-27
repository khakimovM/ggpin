# 01 — Mahsulot talablari (PRD)

> Brend: **ggpin** (doim kichik harfda; "gg" — *good game*). Domen: `ggpin.uz`, bot: `@ggpin_bot`.
> Kodda nom faqat `packages/shared/src/brand.ts` va env'da (`BRAND_NAME`, `TELEGRAM_BOT_USERNAME`) turadi.

## Maqsad

O‘zbekistondagi foydalanuvchilar uchun **raqamli xizmatlar do‘koni**: Telegram Stars, Telegram
Premium va o‘yinlar uchun donatlar (UC, olmos, Steam balans, Robux va boshqalar). Funksional
jihatdan @buypinbot bilan teng, lekin:

- dizayni ancha zamonaviy va tushunarli (Claude Design'da avval chiziladi);
- xarid tezroq: balans yetmasa, yetishmagan summani to‘lash va xaridni bitta oqimda yakunlash;
- har bir buyurtmaning holati jonli ko‘rinadi;
- web-sayt ham bor (landing + to‘liq do‘kon), faqat Telegram emas;
- bot va interfeys **o‘zbek va rus tillarida**.

## Kanallar

| Kanal | Nima | Kim uchun |
|---|---|---|
| Telegram bot | Kirish nuqtasi, til tanlash, menyu, bildirishnomalar, referal havola | Hamma |
| Telegram Mini App (`/tg`) | Asosiy do‘kon: katalog, xarid, balans, tarix, profil | Telegram foydalanuvchilari |
| Web-sayt | Landing (SEO), web do‘kon (Telegram orqali kirish), to‘lov sahifalari | Google/Yandex'dan kelganlar, kompyuterdagilar |
| Admin panel | Buyurtmalar, foydalanuvchilar, mahsulotlar, narxlar, to‘lovlar, hamyon, ta'minotchilar | Ega va operatorlar |

## Foydalanuvchi rollari

- **Foydalanuvchi** — o‘z balansi, buyurtmalari, referallari.
- **Admin rollari** (`docs/09-ADMIN-PANEL.md`): `OWNER` (hammasi), `OPERATOR` (buyurtmalar,
  qayta urinish, cheklangan qaytarish), `SUPPORT` (faqat ko‘rish va izoh).

## Funksional modullar

### 1. Kirish va profil
- Mini App: Telegram `initData` orqali avtomatik kirish (parol yo‘q).
- Web: "Telegram orqali kirish" — bot 6 xonali kod yuboradi (FinTrack'dagi kabi).
- Profil: ism, @username, ID, til (uz/ru), telefon raqamini ulashish (ixtiyoriy), tungi/yorug‘ rejim
  (web'da; Mini App'da Telegram mavzusi).

### 2. Katalog
- Kategoriyalar: **Telegram** (Stars, Premium), **O‘yinlar** (PUBG, MLBB, Free Fire, Standoff 2...),
  **Platformalar** (Steam, Roblox, Discord...). Qidiruv.
- Mahsulot kartochkasi: rasm, nom, region belgisi (Global / SNG / UZ), yetkazish turi belgisi
  (⚡ Avto, 🎟 Promokod), "mashhur" belgisi, "Tugagan" holati.
- Yetkazish turlari: `TG_USERNAME`, `GAME_ID`, `STEAM_LOGIN`, `VOUCHER`, `USERNAME`
  (batafsil: `docs/06-FULFILLMENT.md`).

### 3. Xarid oqimi
1. Mahsulot → paket (SKU) yoki erkin miqdor (Stars: 50 dan) tanlanadi.
2. Qabul qiluvchi kiritiladi (username / player ID / login) → **"Tekshirish"** → server ism va
   avatarni qaytaradi → foydalanuvchi tasdiqlaydi.
3. Server **narx kotirovkasi** beradi (10 daqiqa amal qiladi).
4. "Sotib olish": balansdan yechiladi. Balans yetmasa — "Mablag‘ yetarli emas" oynasi:
   **"X so‘m to‘ldirish va sotib olish"** (yetishmagan summa avtomatik qo‘yiladi) yoki "Hisobni to‘ldirish".
5. Buyurtma holati jonli: To‘landi → Navbatda → Bajarilmoqda → Yetkazildi / Muvaffaqiyatsiz
   (pul avtomatik balansga qaytadi).
6. Bot ham natija haqida xabar yuboradi.

### 4. Balans (hamyon)
- So‘mdagi balans; to‘ldirish usullari: Click, Payme, Uzum, Rahmat (+ ixtiyoriy Telegram Stars).
- Minimal to‘ldirish summasi (sozlanadi, masalan 5 000 so‘m).
- "Qo‘llanma" — to‘ldirish bo‘yicha qisqa yo‘riqnoma.

### 5. Tarix
- "Buyurtmalar" (holat filtrlari: Barchasi, Bajarildi, Kutilmoqda, Bekor qilingan) va
  "Moliya" (to‘ldirishlar, xaridlar, qaytarishlar, bonuslar).
- Buyurtma tafsiloti: mahsulot, qabul qiluvchi, summa, vaqt, holat, (voucher bo‘lsa) kod va
  "Nusxalash".

### 6. Referal
- Shaxsiy havola `t.me/<bot>/app?startapp=ref_<code>` va `t.me/<bot>?start=ref_<code>`.
- Taklif qilingan do‘stning har bir **yetkazilgan** xaridi uchun 1% bonus (so‘mda, balansga).
- Taklif qilinganlar ro‘yxati va jami daromad.

### 7. Keshbek va chegirma kodlari
- Har bir yetkazilgan xariddan keshbek tangalar (foiz sozlanadi).
- Tangalar evaziga chegirma kodi "sotib olinadi" (masalan 0,2% / 0,5% / 1% / 1,5%).
- "Mening kodlarim", xaridda kodni qo‘llash.

### 8. Bonus kodlar
- Admin yaratgan promo kod → balansga bonus yoki keshbek tanga. Bir foydalanuvchiga bir marta,
  umumiy limit, muddat.

### 9. Yordam
- Mini App ichida FAQ + "Operatorga yozish" (bot orqali support chat yoki operator akkaunti).

### 10. Ijaraga (NFT gift'lar)
- **MVP'da yo‘q.** Keyingi bosqichlar uchun g‘oya (`docs/13-DECISIONS.md`).

## Ishga tushirish tartibi

1. **MVP:** Telegram Stars + Telegram Premium, balans, 1–2 to‘lov tizimi, bot (uz/ru), Mini App,
   landing, admin panel, referal.
2. Keyin o‘yinlar ketma-ket: PUBG Mobile → Mobile Legends → Steam (+ CS2) → Roblox → boshqalar.
   Batafsil: `docs/11-ROADMAP.md`.

## Funksional bo‘lmagan talablar

- **Ishonchlilik:** pul hech qachon ikki marta yechilmaydi yoki yuborilmaydi; noma'lum holat →
  qo‘lda tekshiruv.
- **Tezlik:** katalog < 1 s (Mini App, 4G), Stars buyurtmasi odatda < 2 daqiqada yetkaziladi.
- **Mavjudlik:** to‘lov webhook'lari 99,9%; Fragment ishlamasa zaxira yo‘lga avtomatik o‘tish.
- **Xavfsizlik:** `docs/10-SECURITY.md`.
- **Tillar:** uz (standart), ru — har bir matn ikkala tilda.
- **Qurilmalar:** 375 px dan boshlab; Telegram iOS/Android/Desktop/Web.

## Muvaffaqiyat ko‘rsatkichlari

- Buyurtmaning yetkazilish ulushi ≥ 99%, o‘rtacha yetkazish vaqti (Stars) < 2 daqiqa.
- Qo‘lda tekshiruvga tushgan buyurtmalar < 0,5%.
- To‘ldirishdan xaridgacha konversiya, takroriy xaridlar ulushi, referal orqali kelganlar ulushi.
