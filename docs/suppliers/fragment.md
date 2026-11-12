# Fragment (Telegram Stars va Premium)

> **Holat (2026-11-12): hamma band «taxmin».** Fragment’ning rasmiy API’si yo‘q. Quyidagilar
> ochiq manbalardan (pastda) olingan va tekshirilmagan. Ega `fragment:record` vositasini
> ishga tushirgach, har band yozib olingan fixture bilan solishtiriladi va belgisi
> **«fixture’dan»** ga o‘zgaradi (yoki tuzatiladi).
>
> Belgilar: **taxmin** — manbadan yoki mantiqdan, tekshirilmagan; **fixture’dan** —
> staging’dan bosh sessiya ko‘rib chiqib repoga ko‘chirgan fixture bilan tasdiqlangan
> (`apps/worker/src/adapters/fragment/__fixtures__/`). Vositaning o‘zi repoga hech narsa yozmaydi.

## 1. Umumiy tuzilma

| Band             | Qiymat                                                                                       | Belgi  |
| ---------------- | -------------------------------------------------------------------------------------------- | ------ |
| Asosiy manzil    | `https://fragment.com` (faqat shu host; boshqa host yoki unga redirect → to‘xtash)           | taxmin |
| Ichki API        | `POST https://fragment.com/api?hash=<hash>`                                                  | taxmin |
| So‘rov tanasi    | `application/x-www-form-urlencoded; charset=UTF-8`; `method=<metod nomi>` + metod maydonlari | taxmin |
| Javob            | JSON; muvaffaqiyatsizlikda `{"error": "..."}`                                                | taxmin |
| Sessiya          | brauzer cookie’lari (Telegram orqali kirish + TON Connect hamyon ulanishi)                   | taxmin |
| Stars sahifasi   | `GET /stars/buy` (HTML)                                                                      | taxmin |
| Premium sahifasi | `GET /premium/gift` (HTML)                                                                   | taxmin |
| Testnet          | yo‘q: Fragment + TON birga faqat mainnet’da (plan §8)                                        | taxmin |

## 2. `hash` qanday olinadi

- Sahifa HTML’ida `/api?hash=<hex>` qatori bor; JS ichida `\/api?hash=...` ko‘rinishida
  (JSON-escape) bo‘lishi mumkin. Ajratish: avval `\/` → `/`, keyin `\/api\?hash=([a-fA-F0-9]+)`.
  **taxmin**
- `hash` sahifaga bog‘liq va vaqt o‘tishi bilan almashadi. API `"Bad request"` qaytarsa —
  sahifani qayta olib, yangi `hash` bilan bir marta qayta urinish. **taxmin**
- `hash` sir sifatida qaraladi: log’ga va fixture’ga tushmaydi (`<REDACTED:hash>`).

## 3. So‘rov sarlavhalari (API chaqiruvi)

| Sarlavha           | Qiymat                                                     | Belgi  |
| ------------------ | ---------------------------------------------------------- | ------ |
| `Accept`           | `application/json, text/javascript, */*; q=0.01`           | taxmin |
| `Content-Type`     | `application/x-www-form-urlencoded; charset=UTF-8`         | taxmin |
| `Origin`           | `https://fragment.com`                                     | taxmin |
| `Referer`          | sahifa manzili (masalan, `https://fragment.com/stars/buy`) | taxmin |
| `X-Requested-With` | `XMLHttpRequest`                                           | taxmin |
| `Cookie`           | sessiya cookie’lari                                        | taxmin |

Redirect’lar avtomatik kuzatilmaydi (`redirect: manual`): API javobidagi redirect — xato holati.

## 4. Cookie’lar

| Nomi             | Vazifasi                                                                            | Belgi  |
| ---------------- | ----------------------------------------------------------------------------------- | ------ |
| `stel_ssid`      | sessiya identifikatori                                                              | taxmin |
| `stel_dt`        | brauzer vaqt zonasi siljishi (masalan, `-300`); sir emas, lekin baribir yashiriladi | taxmin |
| `stel_token`     | Telegram orqali kirish tokeni                                                       | taxmin |
| `stel_ton_token` | ulangan TON hamyon sessiyasi; yo‘q bo‘lsa to‘lov havolasi olinmaydi                 | taxmin |

- Har javobdagi `Set-Cookie` cookie to‘plamini yangilaydi (`Max-Age=0` yoki o‘tgan `Expires` →
  o‘chirish; boshqa `Domain` → e’tiborsiz). Bu `FragmentSession` yangilanishining asosi (S7).
- Sessiya umri noma’lum (docs/06: 2–3 hafta kuzatiladi). **taxmin**

## 5. Metodlar (Stars)

| #   | Metod                  | So‘rov maydonlari                                                                                                                     | Javob (kutilgan)                                                                                                                                                                            | Pul bilan bog‘liqmi                               | Belgi  |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ |
| 1   | `searchStarsRecipient` | `query` (username, `@`siz), `quantity` (bo‘sh)                                                                                        | `{"ok":true,"found":{"recipient":"<shaffof id>","name":"...","photo":"<img ...>","myself":bool}}`; topilmasa `error` (`"No Telegram users found"` kabi)                                     | yo‘q                                              | taxmin |
| 2   | `initBuyStarsRequest`  | `recipient` (1-javobdan), `quantity` (masalan, `50`), `payment_method` (`ton`)                                                        | `{"req_id":"...","amount":"<TON, o‘nlik>", ...}`                                                                                                                                            | so‘rov yaratadi, pul yo‘q                         | taxmin |
| 3   | `getBuyStarsLink`      | `id` (= `req_id`), `transaction=1`, `show_sender` (`0`/`1`), `account` (TON Connect account JSON), `device` (TON Connect device JSON) | `{"ok":true,"transaction":{"validUntil":<unix>,"messages":[{"address":"<Fragment manzili>","amount":"<nanoton>","payload":"<base64 BOC>"}]},"confirm_method":"...","confirm_params":{...}}` | tranzaksiya **tavsifi**; imzolanmaguncha pul yo‘q | taxmin |
| —   | `updateStarsBuyState`  | `quantity`                                                                                                                            | narx/holat yangilanishi (narx manbai bo‘lishi mumkin, `CostSource`)                                                                                                                         | yo‘q                                              | taxmin |

- `account` qiymati: `{"address":"0:<hex>","chain":"-239","walletStateInit":"<base64>","publicKey":"<hex>"}`
  (TON Connect `account` shakli). Fragment uni `stel_ton_token` dagi hamyon bilan solishtirsa
  kerak. **taxmin**
- `payload` — matnli izohli BOC; izohda Stars soni, qabul qiluvchi username va `Ref#...` bo‘lishi
  mumkin. Shuning uchun fixture’da username bor `payload` butunlay `<REDACTED:payload>` bo‘ladi. **taxmin**
- `confirm_method`/`confirm_params` — Fragment sahifasi imzolangan BOC ni qaytarib yuboradigan
  usul. Yozib olish vositasi bu metodni **chaqirmaydi** (ruxsat ro‘yxatida yo‘q). Adapter (S8)
  uchun: yuborishni biz o‘zimiz TON tarmog‘iga qilamiz; Fragment’ga BOC qaytarish kerakmi — ochiq
  savol (6-bo‘lim). **taxmin**

## 6. Metodlar (Premium) — S0b’da yozib olinmaydi

| Metod                        | Maydonlar                                                 | Belgi  |
| ---------------------------- | --------------------------------------------------------- | ------ |
| `searchPremiumGiftRecipient` | `query`, `months`                                         | taxmin |
| `initGiftPremiumRequest`     | `recipient`, `months` (3/6/12)                            | taxmin |
| `getGiftPremiumLink`         | `id`, `transaction=1`, `show_sender`, `account`, `device` | taxmin |
| `updatePremiumState`         | —                                                         | taxmin |

## 7. «Login holatidaman» belgisi (keep-alive uchun, S7)

Vosita sahifadagi nomzod belgilarni yozib oladi (`summary.json` → `pageMarkers`). Qaysi biri
ikki holatni ajratishi yozuvdan keyin tanlanadi.

| Belgi                                                          | Login bor             | Login yo‘q                  | Belgi  |
| -------------------------------------------------------------- | --------------------- | --------------------------- | ------ |
| `tm-menu-tg-account` / `tm-settings-account` (akkaunt menyusi) | bor                   | yo‘q                        | taxmin |
| `logOut` / `js-logout`                                         | bor                   | yo‘q                        | taxmin |
| `js-header-login` / «Log in» tugmasi                           | yo‘q                  | bor                         | taxmin |
| `tm-wallet` / `Wallet.init(` / tonconnect                      | hamyon ulangan bo‘lsa | —                           | taxmin |
| `/api?hash=`                                                   | bor                   | ehtimol bor (login’siz ham) | taxmin |

## 8. Xato holatlari

| Holat                                 | Qanday ko‘rinadi                                                                 | Adapter qarori (reja)                         | Belgi  |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- | ------ |
| `hash` eskirgan                       | `{"error":"Bad request"}`                                                        | sahifani qayta olish, bir marta qayta urinish | taxmin |
| Sessiya tugagan                       | `{"error":"Session expired"}`/`"Unauthorized"`, yoki sahifada login belgisi yo‘q | `FragmentSession=DEAD`, alert, zaxira (S7)    | taxmin |
| Qabul qiluvchi topilmadi              | `error` ichida `No Telegram users found`                                         | `RECIPIENT_NOT_FOUND`                         | taxmin |
| KYC talab qilinadi                    | `need_verify` yoki maxsus `error`                                                | HELD + alert                                  | taxmin |
| Hamyon ulanmagan / `account` mos emas | `getBuyStarsLink` → `error`                                                      | HELD + alert                                  | taxmin |
| To‘lov usuli almashgan                | javobda `evm` kabi kutilmagan kalit                                              | adapter `DOWN`                                | taxmin |
| Boshqa host’ga redirect               | `3xx` + `Location`                                                               | to‘xtash                                      | taxmin |
| JSON emas / Zod’dan o‘tmaydi          | —                                                                                | adapter `DOWN`, alert (docs/06 4-band)        | taxmin |

## 9. Ochiq savollar (yozuvdan keyin javob beriladi; plan §7)

1. `recipient` qiymati qancha yashaydi? (`--recipient-age-check`: 10 daqiqadan keyin `init` qayta.)
2. To‘lovdan keyin Fragment holatini so‘rash usuli bormi (Q6)?
3. Fragment to‘lov manzili barqarormi (Q7 allowlist)? `summary.json` → `payAddresses`.
4. Narxni so‘rovsiz olish mumkinmi (init `amount` yoki sahifa)?
5. `getBuyStarsLink` uchun `account`/`device` majburiymi?
6. KYC talabi bormi?

## 10. Yozib olish vositasi (`fragment:record`, S0b)

- Fayllar: `apps/worker/src/cli/fragment-record*.ts`; sanitizer —
  `apps/worker/src/adapters/fragment/fixture-sanitizer.ts` (+ `sanitizer-rules.ts`,
  `secret-forms.ts`, `payload-scan.ts`); leak-tekshiruv — `leak-check.ts` + `leak-probes.ts` +
  `leak-views.ts`. Ma’lum sirlar bo‘yicha probe’lar va dekodlash sanitizer naqshlarini
  ishlatmaydi (mustaqil); noma’lum qiymatning umumiy shakllari (cookie juftligi, API hash, base64
  rasm, telefon) esa `secret-shapes.ts` da, ikkala qatlam uchun BIR XIL — bu qism mustaqil ikkinchi
  fikr emas.
- Faqat ega o‘z kompyuterida ishga tushiradi. Rad etiladi (exit 2, hech narsa o‘qilmaydi):
  `NODE_ENV=production`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, bo‘sh bo‘lmagan `NODE_OPTIONS`,
  `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_DEBUG`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY` (kichik harfli shakllari ham), hamda `node` ning har qanday buyruq
  qatori opsiyasi (`node --inspect …`, `process.execArgv` bo‘sh emas). **Cheklov:** `NODE_OPTIONS` tekshiruvi Node
  `--require`/`--import` preload’laridan KEYIN ishlaydi — preload kod bu tekshiruvdan oldin
  bajarilib bo‘ladi; shuning uchun vositani faqat toza terminalda ishga tushiring. `.env`
  o‘qilmaydi. TON kutubxonasi, imzo yoki yuborish kodi yo‘q; faqat `searchStarsRecipient`,
  `initBuyStarsRequest`, `getBuyStarsLink` chaqiriladi (ikkinchi va uchinchisi faqat
  `--confirm-no-payment` bilan). npm orqali ishga tushirilsa (`npm_lifecycle_event` bor), stderr’ga
  qiymatsiz ogohlantirish chiqadi: npm buyruq qatorini konsolga va o‘z log fayliga yozadi.
- Majburiy bayroqlar: `--cookies`, `--username`, `--telegram-id` (har doim; id faqat yashirish
  uchun). `--confirm-no-payment` bilan yana `--wallet <manzil>` (egasining hamyoni), kamida
  bitta `--name "<ko‘rinadigan ism>"` (takrorlanadi; `--redact` qatori uning o‘rnini bosmaydi)
  hamda `--phone <raqam>` (takrorlanadi) yoki `--redact` faylidagi telefon qatori majburiy, aks
  holda exit 2. Yozuv oxirida birorta ism ma’lum bo‘lmasa (`nothing staged: no display name is
known`), `--name` lardan birortasi ham javoblarda uchramasa (`nothing staged: name not found in
responses`) yoki biror `--name` ning so‘zlari (≥3 belgi) qisman topilsa (`nothing staged: name N
partly found` — N tartib raqami, qiymat chiqmaydi; odatda imlo xatosi), staging’ga hech narsa
  yozilmaydi, exit 1. Apostrof shakllari (`'`, `` ` ``, `´`, `‘`, `’`, `ʹ`, `ʻ`, `ʼ`, `ꞌ`) bir xil
  hisoblanadi. Sahifada API `hash` topilmasa (`stopped early: no api hash`), sahifa fayllari
  staging’ga yozilmaydi (`withheld: <fayl> (no api hash)`), faqat `summary.json`, exit 1.
  `--ton-connect <fayl>` faqat bosh sessiya ko‘rsatmasi bilan.
- **Vosita repoga umuman yozmaydi va undan o‘qimaydi.** Ikki papka, ikkalasi ham bo‘sh (yoki
  yangi) va bir-birining ichida emas; har tekshiruv HAQIQIY yo‘lda (junction/symlink ochilgan,
  eng yaqin mavjud ota-papka orqali) ishlaydi va `mkdir` dan keyin qayta tekshiriladi:
  - `--out` — xom javoblar (standart `~/Desktop/ggpin-secrets/fragment-raw/<vaqt>`);
  - `--fixtures` — staging: tozalangan nusxalar (standart
    `~/Desktop/ggpin-fixtures-staging/<vaqt>`, **`ggpin-secrets` dan tashqarida**: bosh sessiya
    uni o‘qiydi, `ggpin-secrets` ni esa hech qachon o‘qimaydi; staging `ggpin-secrets` ichida
    bo‘lsa — rad etiladi).
  - `--out`, `--fixtures`, `--cookies`, `--redact`, `--ton-connect` uchun rad etiladi (exit 2):
    git repo ichidagi yo‘l, UNC/qurilma yo‘li (`\\server\...`, `\\?\...`), OneDrive (yo‘lda
    `OneDrive...` segmenti yoki `%OneDrive%`/`%OneDriveConsumer%`/`%OneDriveCommercial%` ichida),
    nuqta yoki bo‘shliq bilan tugaydigan papka nomi.
- Butun sahifa/matn AVVAL to‘liq tozalanadi, keyin undan parcha olinadi: HTML’dan staging’ga faqat
  parcha (`bodyKind: "html-excerpt"`, `pageTitle`, `apiUrl` qatori, login marker’lari atrofidagi
  qisqa bo‘laklar, chetlari bo‘shliq/`<>"'` gacha qirqilgan), matn javobi — birinchi 2000 belgi.
  To‘liq tozalangan sahifa ham leak-tekshiruvdan o‘tadi; u yiqilsa parcha ham yozilmaydi. To‘liq
  xom sahifa faqat `--out` da.
- Har fayl yozishdan oldin mustaqil leak-tekshiruvdan o‘tadi: matn URL-decode (bir necha qavat),
  HTML-entity, JSON-unescape, `+` → bo‘shliq, NFKC/NFC/NFD, teg va ko‘rinmas belgilarsiz
  ko‘rinishlar, ≥8 belgili base64 bo‘laklari (bayt darajasida qayta ochiladi) bo‘yicha ochiladi;
  ism so‘zlari, username, id va telefon (raqamlar orasida 3 tagacha boshqa belgi bilan),
  cookie/hash/recipient’ning ≥12 belgili bo‘laklari va `decodeURIComponent` shakli, hamyon
  shakllari (har 10 belgili oyna, oxirgi 8 belgi, `boshi4…oxiri4`/`...`), har o‘rindagi 48 belgili
  oynadagi begona TON manzili, uzun hex va hisob hash’i (har bit siljishida) qidiriladi. Topilsa
  fayl yozilmaydi: stdout’da `withheld: <fayl> (leak check: <qoida nomlari>)`, exit 1.
- Saqlanadigan yagona manzil — `getBuyStarsLink` javobidagi Fragment to‘lov manzili, aynan berilgan
  yozilishida va faqat javobda AYNAN BITTA xabar bo‘lsa (aks holda yozuv to‘xtaydi, exit 1);
  egasining hisobiga teng manzil saqlanmaydi — **faqat to‘g‘ri `--wallet` berilsa**: boshqa hamyon
  berilsa, Fragment’ga ulangan haqiqiy hamyon yagona xabar manzili sifatida saqlanib qolishi
  mumkin (auditdagi KEEP1 sharti).
- Placeholder’lar (yopiq ro‘yxat): `<REDACTED:cookie|hash|name|username|photo|photo-url|photo-data|recipient|address|wallet|tg_id|phone|secret|payload|token|email|kyc>`;
  JSON’dagi raqamli Telegram id / telefon → `0`. BOC payload doim `<REDACTED:payload>`
  (fail-closed); kaliti noma’lum uzun tasodifiy qiymat va saqlanmagan har qanday ≥32 belgili hex →
  `<REDACTED:token>`; qisqartirilgan manzil (`UQAB…wxyz`, `UQAB … wxyz`, `UQABcd***uvwxyz`) →
  `<REDACTED:address>`; telefon shakllari (`+…`, `998…`, `8 916 …`, `90 123 45 67`,
  `90-123-45-67`, `(90) 123-45-67`, `90 1234567`, `90.123.45.67`, telefon so‘zidan keyin yoki
  elementda yolg‘iz turgan `901234567`; operator kodlari 9x, 33, 88, 77, 20, 50, 55) →
  `<REDACTED:phone>`. Kontekstsiz matn ichidagi yalang‘och 9 raqam (`id`, summa) telefon deb
  hisoblanmaydi — egasining raqami esa `--phone` orqali har shaklda yashiriladi. Cookie (`stel_x:
v`, `{'stel_x':'v'}`, `["stel_x","v"]`, `name=stel_x&value=v`, `&equals;` va h.k.), hash
  (`apiHash=`, `api_hash:`, `"hash":"h"`, `data-hash=`, `/api/hash/h`) va har qanday `data:…;base64,`
  (qatorlarga bo‘lingan bo‘lsa ham) noma’lum qiymat bilan ham yashiriladi.
- Staging fayllari: `page-logged-in.json`, `search-stars-recipient.json`, `init-buy-stars.json`,
  `get-buy-stars-link.json`, `page-logged-out.json`, `init-buy-stars-after-10min.json`
  (ixtiyoriy), `summary.json` (`format: 3`, `tonSent: false`, `linkPayloads`).
- Production image’da yo‘q: `apps/worker/Dockerfile` `dist/cli/fragment-record*` va
  `dist/config/fragment-record-env.*` ni o‘chiradi va iz qolsa build’ni yiqitadi.

## 11. Ega uchun yo‘riqnoma

**Chatga (yoki boshqa joyga) hech qachon yozilmaydi:** cookie qiymatlari, username, Telegram id,
hamyon manzili (to‘liq yoki bir qismi), ism, telefon raqami, buyruqning o‘zi va stdout’ning
boshqa qatorlari. Chatga **faqat** shular yoziladi: `withheld:`, `stopped early:` va
`nothing staged` bilan boshlanadigan qatorlar hamda exit kodi (`$LASTEXITCODE`).

1. Sinov hamyonida S0b paytida **0 TON**. Tonkeeper biror so‘rov chiqarsa → **Decline**.
2. Brauzer profili kengaytmalarsiz. `ggpin-secrets` va staging OneDrive’ga sinxron qilinmaydi;
   `fragment-raw` AI kengaytmali muharrirda ochilmaydi. Toza PowerShell oynasi (proxy va
   `NODE_*` o‘zgaruvchilarsiz).
3. **Ishchi akkaunt (D-58):** Fragment va bank xabarlari uchun BITTA ishchi Telegram akkaunti
   ishlatiladi; quyidagi `--username`, `--telegram-id`, `--phone` va `--name` — shu ishchi
   akkauntniki. fragment.com’ga brauzerda **Telegram orqali** kiring (Log in → Telegram) va
   Tonkeeper hamyonini ulang (o‘sha 0 TON li hamyon). Ishchi akkauntga **yangi qurilma ulanmaydi**
   (Telegram Desktop, boshqa telefon, QR-login yo‘q): yangi qurilma bank-feed himoyasini ishga
   tushirib, barcha kartalarda avtomatik yozishni to‘xtatadi. Kirishni **faqat mavjud telefondagi**
   Telegram’da tasdiqlang. S0b’dan keyin Telegram → Settings → Privacy and Security → Active
   Websites ro‘yxatida fragment.com qoladi — bu kutilgan holat (S7 shu sessiyadan foydalanadi).
4. Cookie olish: DevTools (F12) → Network → sahifani yangilang → `stars/buy` so‘rovi → Request
   Headers → `cookie` → o‘ng tugma → **Copy value**.
5. Windows’da bulutli clipboard sinxronini o‘chiring (Settings → System → Clipboard → «Sync
   across devices» — Off). Cookie faylini yozish:
   `Get-Clipboard -Raw | Set-Content -NoNewline $env:USERPROFILE\Desktop\ggpin-secrets\fragment-cookies.txt`.
   Keyin Win+V → «Clear all».
6. Repo ildiziga o‘ting va build qiling (`@repo/shared` va `@repo/db` ham dist bilan quriladi):
   ```
   cd $env:USERPROFILE\Desktop\ggpin-platform
   npx turbo run build --filter=worker
   ```
7. Ishga tushirish — **npm’siz**, repo ildizidan (npm buyruq qatorini konsolga va
   `%LocalAppData%\npm-cache\_logs` dagi log fayliga yozadi):
   ```
   node apps\worker\dist\cli\fragment-record.js --cookies $env:USERPROFILE\Desktop\ggpin-secrets\fragment-cookies.txt --username <username> --telegram-id <id> --confirm-no-payment --wallet <manzil> --phone <raqam> --name "<to‘liq ism>" --name "<ism>" --name "<familiya>" [--redact $env:USERPROFILE\Desktop\ggpin-secrets\redact.txt] [--recipient-age-check]
   ```
   - `--username` **`@` siz** yoziladi: PowerShell `@` ni splatting deb tushunadi.
   - `--name`: Telegram profilidagi ism **aynan nusxalanadi** — to‘liq ism, ism va familiya
     alohida-alohida. Ismda o‘ yoki g‘ bo‘lsa, har apostrof shakli bilan ham bering (`O'`, `O‘`,
     `Oʻ`, `Oʼ`; vosita ularni bir xil deb hisoblaydi, lekin ortiqchasi zarar qilmaydi).
   - `--wallet`: Fragment’ga ulangan **aynan o‘sha** hamyon (Tonkeeper’dan nusxa), unda 0 TON.
     Boshqa hamyon berilsa, haqiqiy hamyon staging’da qolishi mumkin.
   - `--phone`: ishchi akkaunt raqami; `--telegram-id` va `--username` ham ishchi akkauntniki.
   - `--name` majburiy (`--redact` qatori yetmaydi). `nothing staged: name N partly found`
     chiqsa, N-chi `--name` dagi so‘zlardan biri profildagidan farq qiladi (imlo, H/X, ortiqcha
     harf): profildan qayta nusxalab, yana ishga tushiring.
   - `node` ga opsiya bermang (`node --inspect …` rad etiladi, exit 2).
   - `--ton-connect` faqat bosh sessiya aytsa qo‘shiladi.
   - Muqobil (tavsiya etilmaydi): `npm run -s fragment:record -w worker --logs-max=0 -- …`;
     vosita npm orqali ishga tushganini sezsa, qiymatsiz ogohlantirish chiqaradi.
8. Natija: chatga faqat yuqoridagi ruxsat etilgan qatorlar va exit kodi. Staging papkada
   (`$env:USERPROFILE\Desktop\ggpin-fixtures-staging\<vaqt>`) qidiring: username (oddiy va
   `%40<username>`), Telegram id, hamyon manzilining birinchi 4–6 va oxirgi 8 belgisi,
   ismingizdagi har so‘z, telefon raqamingiz. Hech narsa topilmasa — «tayyor» deysiz; bosh
   sessiya ko‘rib chiqadi.
9. Bosh sessiya ko‘rib chiqqandan keyin `$env:USERPROFILE\Desktop\ggpin-secrets\fragment-raw\<vaqt>`
   papkasini o‘chiring. Cookie fayli S7 importidan keyin o‘chiriladi.
10. Izlarni tozalash: `Clear-History`, so‘ng `(Get-PSReadLineOption).HistorySavePath` faylidan
    cookie, id, manzil, ism yoki telefon bor qatorlarni o‘chiring. npm ishlatilgan bo‘lsa,
    `$env:LocalAppData\npm-cache\_logs` ichidagi shu vaqtdagi log fayllarini o‘chiring.
11. Hodisa yuz bersa (sir staging’ga yoki boshqa joyga tushdi): fragment.com’da **Log out**;
    Telegram → Settings → Privacy and Security → Active Websites → Fragment → **Disconnect**;
    Tonkeeper’da Fragment ulanishini uzing; `fragment-raw` va staging papkalarini o‘chiring.
    (Hodisa bo‘lmasa, Active Websites dagi Fragment uzilmaydi — 3-band.) Qayta kirish ham
    brauzerda Telegram orqali, faqat mavjud telefonda tasdiqlanadi.

## Manbalar (rasmiy emas, ishonchsiz)

- [Habr: Fragment ichki API chaqiruvlari haqida maqola](https://habr.com/ru/articles/1095242/) —
  `initBuyStarsRequest` (`recipient`, `payment_method`, `quantity`), `getBuyStarsLink`
  (`id`, `transaction`, `show_sender`, `account`, `device`), `/api?hash=…`.
- [s1qwy/fragment-api-py (GitHub)](https://github.com/s1qwy/fragment-api-py) — metod nomlari,
  sarlavhalar, cookie nomlari, `hash` regex’i. **Diqqat:** kutubxona konstantalarida
  `FEE_ADDRESS` va 1,5% `FEE_BASIS_POINTS` bor — begona manzilga komissiya. Uni ishlatmaymiz,
  koddan ko‘chirmaymiz (faqat o‘qildi).
- [NightStrang6r/FragmentAPI (GitHub)](https://github.com/NightStrang6r/FragmentAPI) — uchinchi
  tomon xizmati: cookie va hamyon seed’ini **ularning serveriga** yuborishni so‘raydi. Hech
  qachon ishlatilmaydi; ichki endpointlar haqida ma’lumot bermaydi.
- `docs/06-FULFILLMENT.md`, skill `fragment-ton`, plan §7.
