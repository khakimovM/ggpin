# 09 — Admin panel

Alohida ilova: `apps/admin` (React + Vite), alohida subdomen (`admin.<domen>`), API: `/api/v1/admin/*`.
Interfeys tili — o‘zbekcha.

## Kirish va rollar

| Rol        | Kim                         | Huquqlar                                                                                                                                 |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER`    | Ega                         | Hammasi: pul amallari, sozlamalar, adminlar, hamyon limitlari                                                                            |
| `OPERATOR` | Buyurtmalar bilan ishlovchi | Buyurtmalar (qayta urinish, tekshiruvni yakunlash), `ADMIN_OPERATOR_REFUND_MAX_TIYIN` gacha qaytarish, foydalanuvchini bloklash, support |
| `SUPPORT`  | Yordam xodimi               | Faqat ko‘rish (buyurtma, foydalanuvchi), izoh qoldirish                                                                                  |

- Kirish: `/login` → "Telegram orqali kirish" → bot `admin_<nonce>` → **faqat** `ADMIN_TELEGRAM_IDS`
  dagi va `AdminUser.isActive` bo‘lgan ID'ga kod keladi. Boshqalarga bot "havola eskirgan" deydi.
- Telegram ichidan: `/admin` buyrug‘i → Mini App sifatida panel (initData + allowlist).
- Sessiya: 8 soat mutlaq, 1 soat harakatsizlik; har so‘rovda allowlist qayta tekshiriladi.
- Ruxsatsiz → 404. Har bir o‘zgartiruvchi amal → `AuditLog` (kim, nima, oldin/keyin, sabab, IP).
- Pul amallari (qaytarish, balans tuzatish, qo‘lda "yetkazildi"): sabab majburiy; summa
  `ADMIN_CONFIRM_THRESHOLD_TIYIN` dan katta bo‘lsa — botga kelgan tasdiq kodi so‘raladi.

## Bo‘limlar

### 1. Dashboard

- KPI: bugungi/haftalik/oylik aylanma, buyurtmalar soni, yetkazish ulushi, o‘rtacha yetkazish vaqti,
  yalpi foyda (narx − tannarx), yangi foydalanuvchilar, to‘ldirishlar summasi.
- Grafiklar: aylanma va foyda dinamikasi, mahsulotlar bo‘yicha ulush, to‘lov usullari bo‘yicha ulush.
- **Ogohlantirishlar paneli:** NEEDS_REVIEW / HELD buyurtmalar, Fragment sessiyasi holati, hot wallet
  balansi va kunlik limit ishlatilishi, ta'minotchi balanslari, navbatlar holati, solishtirish farqlari.

### 2. Buyurtmalar

- Jadval: #raqam, sana, foydalanuvchi, mahsulot/SKU, qabul qiluvchi, narx, tannarx, foyda, holat, adapter.
- Filtrlar: holat, mahsulot, adapter, sana, summa, foydalanuvchi, qidiruv (#, username, txn hash).
- Tafsilot: holat timeline (`OrderEvent`), `FulfillmentAttempt`lar (so‘rov/javob sirlarsiz, TON tx havolasi
  tonviewer'ga), ledger yozuvlari, kotirovka va kurs snapshoti.
- Amallar (rolga qarab): **Qayta urinish** (faqat isbotlangan "yuborilmagan" holatda), **Yetkazildi deb
  belgilash** (isbot havolasi bilan), **Bajarilmadi + qaytarish**, **Bekor qilish** (PROCESSING'dan oldin),
  **Izoh**.
- "Tekshiruv navbati" — NEEDS_REVIEW va HELD uchun alohida ro‘yxat.

### 3. Foydalanuvchilar

- Ro‘yxat: ID, username, til, ro‘yxatdan o‘tgan sana, oxirgi faollik, balans, xaridlar soni/summasi,
  referallar, holat.
- Tafsilot: buyurtmalar, ledger, to‘lovlar, referal daraxti, keshbek, bonus kodlar.
- Amallar: bloklash/blokdan chiqarish, xaridni muzlatish/ochish, balansni tuzatish (OWNER, sabab bilan),
  sessiyalarni tugatish, botdan shaxsiy xabar.

### 4. Katalog

- Kategoriyalar, mahsulotlar (uz/ru nomlar, tavsif, yordam matni, rasm, region, yetkazish turi,
  input sxema konstruktori, faol/nofaol, tartib), SKU'lar (label uz/ru, miqdor, ta'minotchi SKU,
  ustama %, min marja), mahsulot → adapter marshrutlari (ustuvorlik, yoqish/o‘chirish).
- Narx oldindan ko‘rish: joriy tannarx, kurs, ustama → yakuniy narx.
- Voucher ombori: import (CSV, shifrlanadi), qoldiq, holatlar.

### 5. Narx va sozlamalar

- Global: referal %, keshbek %, chegirma tier'lari, to‘ldirish min/max, narx toleransi, kurs manbalari.
- **Promo sozlamalari (10-bosqich, D-72 (10)):** `Setting` jadvalidagi `REFERRAL_BPS` (1%), `CASHBACK_BPS` (0,5%), `COIN_UNIT_TIYIN`
  (1 tanga = 100 so‘m), `REFERRAL_DAILY_CAP_TIYIN` (inviter’ga kuniga 100 000 so‘m). Faqat OWNER o‘zgartiradi, sabab majburiy, har
  o‘zgarish `AuditLog` ga (oldin/keyin). Chegaralar: referal ≤ 3%, keshbek ≤ 3%, referal + keshbek + eng katta faol tier ≤ 5%
  (`PromoSettingsSchema`, `withinPromoBudget` — `packages/shared/src/promo/promo-settings.ts`). Yangi qiymat keyingi yetkazishlarga
  amal qiladi; yetkazilgan buyurtmalarning mukofoti qayta hisoblanmaydi.
- **Chegirma tier’lari:** `bps` (< 100%), narxi tangada, bitta kodning eng katta chegirmasi (so‘m), amal qilish muddati (kun), faol/nofaol.
  Boshlang‘ich to‘rttasi: 0,2% / 15, 0,5% / 35, 1% / 70, 1,5% / 90 tanga; chegara 2 000 / 5 000 / 10 000 / 15 000 so‘m; 30 kun (D-72 (5)).
  Tier o‘zgarishi allaqachon sotilgan kodlarga ta’sir qilmaydi (kod `bps` va chegarani nusxa qilib oladi). OPERATOR va SUPPORT faqat ko‘radi.
- Kurslar tarixi (USDT/UZS, TON/USDT) va qo‘lda kurs (favqulodda holat).

### 6. To‘lovlar

- Intentlar va to‘lovlar ro‘yxati, provayder, holat, summa; provayder javoblari (redakt qilingan).
- Solishtirish hisobotlari (kunlik), farqlar va ular bo‘yicha qaror.
- Provayderlarni yoqish/o‘chirish.

### 7. Yetkazish infratuzilmasi

- **Hot wallet:** manzil, TON/USDT balans, kunlik ishlatilgan limit, oxirgi tranzaksiyalar, limitlar (OWNER).
- **Fragment sessiyasi:** holat (ACTIVE/DEAD), oxirgi muvaffaqiyatli tekshiruv, "Sessiyani yangilash" oqimi.
- **Ta'minotchilar:** holat (health), balans, narx yangilangan vaqt, xato statistikasi.
- **Navbatlar:** BullMQ navbatlari holati (kutilayotgan, bajarilayotgan, xato), qayta ishga tushirish.

### 8. Marketing

Yozuvchi amallar faqat OWNER (sabab + `AuditLog`); OPERATOR va SUPPORT faqat ko‘radi (D-72 (12)). Ekranlar 10-bosqichda (API S9,
SPA S12).

- **Bonus kodlar** (D-72 (9)): yaratish — mukofot turi (hamyonga so‘m yoki tanga), qiymat, `maxUses` va muddat (ikkalasi majburiy),
  ichki nom (`label`), «faqat xarid qilganlarga» (so‘m beruvchi kodda standart yoqilgan). Kod tasodifiy (≥ 10 belgi) yoki qo‘lda
  tanlangan (vanity, ≥ 6 belgi); ochiq matni **faqat yaratilganda bir marta** ko‘rsatiladi, bazada HMAC xeshi. Ro‘yxatda: `hint`
  (oxirgi 2 belgi), nom, ishlatilgan / limit, muddat, faol/nofaol; o‘chirib qo‘yish (nofaol qilish). Statistika: faollashtirishlar soni
  va berilgan jami summa/tanga.
- **Rassilka** (D-72 (11)): uz/ru matn, tugma (matn + https havola), auditoriya (hammasi / til / oxirgi N kun faol / xarid qilganlar),
  oldindan ko‘rish, **majburiy** test o‘zingizga, keyin yuborish; kuniga ≤ 2 ta, 22:00–09:00 (Toshkent) yuborilmaydi; hisobot:
  yuborildi / xato / bloklangan. Rasm keyinroq. Tafsilot — `docs/07-BOT.md` «Rassilka».
- **Referal statistikasi:** top taklif qiluvchilar (taklif qilinganlar soni, net bonus), kunlik cheklovga yetganlar
  (`OrderReward.skipReason = DAILY_CAP`), shubhali faollik.
- Foydalanuvchi tafsilotida (3-bo‘lim) «Tangalar» (`CoinEntry` tarixi va balans) va «Kodlar» (chegirma kodlari, ishlatilgan bonus kodlar)
  tablari.

### 9. Audit log

- Barcha admin amallari: vaqt, admin, amal, obyekt, oldin/keyin, sabab, IP. Faqat o‘qish, eksport CSV.

### 10. Adminlar (faqat OWNER)

- Admin qo‘shish (Telegram ID + rol), o‘chirish, faol sessiyalar.

## Xavfsizlik eslatmalari

- Admin API alohida guard va rate limit; CORS faqat admin domeni; cookie `SameSite=Strict`.
- Ta'minotchi kalitlari, mnemonic, cookie'lar admin panelda **hech qachon** ko‘rsatilmaydi va
  tahrirlanmaydi (faqat holat). Ularni almashtirish — server env orqali (devops).
