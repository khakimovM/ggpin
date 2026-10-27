# 12 — "Tayyor" degani nima?

Har bir vazifa uchun quyidagilarning **hammasi** bajarilgan bo‘lishi shart.

## Kod
- [ ] TypeScript strict, `any` / `@ts-ignore` / `!` yo‘q
- [ ] `npm run lint`, `npm run typecheck` yashil
- [ ] Fayllar ~300 satrgacha; controllerda mantiq yo‘q, Prisma faqat repositoryda

## Pul
- [ ] Summalar `BigInt` minimal birlikda, JSONda string
- [ ] Balans ledgerdan; ledger yozuvi va holat o‘zgarishi bitta `$transaction`da
- [ ] Idempotentlik: unique indeks + takroriy so‘rov testi
- [ ] Yaxlitlash yo‘nalishi to‘g‘ri va testlangan

## Xavfsizlik
- [ ] Har bir so‘rov `userId` bilan cheklangan, boshqanikiga 404
- [ ] Yozuvchi endpointlar `.strict()` Zod bilan
- [ ] Sirlar kodda, logda, javobda yo‘q; worker sirlari API'da yo‘q
- [ ] Admin amali audit log yozadi

## Test
- [ ] Biznes qoidasi uchun unit test, xato yo‘li bilan
- [ ] Pul funksiyasi uchun: parallel so‘rov, takroriy so‘rov, qaytarish testlari
- [ ] Ownership e2e testi
- [ ] `.skip` / `.only` yo‘q; `npm run test` va `npm run test:e2e` yashil

## UI
- [ ] Dizayn handoff'ga mos (e2e-qa skrinshotlari bilan)
- [ ] 4 holat: skeleton, xato + qayta urinish, bo‘sh + CTA, to‘ldirilgan
- [ ] 375 / 768 / 1440, yorug‘ + qorong‘i, Mini App varianti
- [ ] Barcha matnlar i18n orqali, **uz va ru ikkalasi ham to‘ldirilgan**, ruscha matn sig‘adi
- [ ] Klaviatura, fokus, kontrast, reduced motion

## Bot
- [ ] Xabarlar uz va ru'da snapshot test bilan
- [ ] Foydalanuvchi matni escape qilingan

## Hujjat
- [ ] `docs/04-API-CONTRACT.md` haqiqiy javobga mos
- [ ] Sxema o‘zgargan bo‘lsa `docs/03-DATA-MODEL.md` yangilangan
- [ ] Yangi env o‘zgaruvchisi `.env.example`da
- [ ] Qabul qilingan qaror `docs/13-DECISIONS.md`da

## Ko‘rib chiqish
- [ ] `code-reviewer` — "ship"
- [ ] Pul / auth / to‘lov / yetkazish / admin bo‘lsa — `security-auditor` ham
- [ ] Hisobot o‘zbekcha: bajarildi / tekshirildi / bajarilmadi / keyingi qadam
