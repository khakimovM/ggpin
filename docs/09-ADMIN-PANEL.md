# 09 — Admin panel

Alohida ilova: `apps/admin` (React + Vite), alohida subdomen (`admin.<domen>`), API: `/api/v1/admin/*`.
Interfeys tili — o‘zbekcha.

## Kirish va rollar

| Rol | Kim | Huquqlar |
|---|---|---|
| `OWNER` | Ega | Hammasi: pul amallari, sozlamalar, adminlar, hamyon limitlari |
| `OPERATOR` | Buyurtmalar bilan ishlovchi | Buyurtmalar (qayta urinish, tekshiruvni yakunlash), `ADMIN_OPERATOR_REFUND_MAX_TIYIN` gacha qaytarish, foydalanuvchini bloklash, support |
| `SUPPORT` | Yordam xodimi | Faqat ko‘rish (buyurtma, foydalanuvchi), izoh qoldirish |

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
- Bonus kodlar (yaratish: mukofot turi, qiymat, limit, muddat; statistika).
- Rassilka (uz/ru matn, rasm, tugma, auditoriya, oldindan ko‘rish, test yuborish o‘zingizga, hisobot).
- Referal statistikasi (top taklif qiluvchilar, shubhali faollik).

### 9. Audit log
- Barcha admin amallari: vaqt, admin, amal, obyekt, oldin/keyin, sabab, IP. Faqat o‘qish, eksport CSV.

### 10. Adminlar (faqat OWNER)
- Admin qo‘shish (Telegram ID + rol), o‘chirish, faol sessiyalar.

## Xavfsizlik eslatmalari
- Admin API alohida guard va rate limit; CORS faqat admin domeni; cookie `SameSite=Strict`.
- Ta'minotchi kalitlari, mnemonic, cookie'lar admin panelda **hech qachon** ko‘rsatilmaydi va
  tahrirlanmaydi (faqat holat). Ularni almashtirish — server env orqali (devops).
