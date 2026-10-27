# ggpin — Telegram Stars, Premium va o‘yin donatlari do‘koni

Telegram bot + Mini App + web-sayt + admin panel. Funksional jihatdan @buypinbot darajasida,
lekin yangi dizayn bilan. Avval **Telegram Stars va Premium** (Fragment + o‘z TON hamyonimiz),
keyin o‘yinlar ketma-ket qo‘shiladi. Bot va interfeys **o‘zbek va rus tillarida**.

Bu papka hozircha **setup**: hujjatlar, Claude Code agentlari, qoidalar, skill'lar, hook'lar va
Claude Design promptlari. Kodni Claude Code `docs/11-ROADMAP.md` bo‘yicha bosqichma-bosqich yozadi.

---

## 1. Ishni boshlash tartibi

### 1-qadam. Dizayn (Claude Design)
1. `design/DESIGN-BRIEF.md` ni oching.
2. Claude Design'da yangi loyiha → **0-prompt** + reference rasmlar → natijani tekshiring.
3. 1 → 9 promptlarni ketma-ket yuboring (har biridan keyin tekshirib, tuzattirib).
4. Handoff qiling → bundle'ni `design/handoff/` ga qo‘ying.

Dizayn davomida backend asosini (0–2-bosqichlar) parallel boshlash mumkin.

### 2-qadam. Muhitni tayyorlash (bir marta)
Talablar: Node.js 22, Docker Desktop, Git, Claude Code.

```bash
cd topup-platform
git init
claude            # Claude Code'ni shu papkada oching
```

Claude Code ichida pluginlarni o‘rnating (rasmiy marketplace avtomatik qo‘shilgan bo‘ladi):

```text
/plugin install security-guidance@claude-plugins-official
/plugin install claude-security@claude-plugins-official
/plugin install code-review@claude-plugins-official
/plugin install pr-review-toolkit@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
/plugin install claude-md-management@claude-plugins-official
```
Har birida **"Install for all collaborators on this repository (project scope)"** ni tanlang.
(`.claude/settings.json` da ular allaqachon yoqilgan, faqat yuklab olish kerak.)

### 3-qadam. Ishlash sikli
```text
/status          — hozir qaysi bosqichdamiz
/next-task       — keyingi vazifa: reja → tasdiq → kod → test → review → hisobot
/review          — joriy o‘zgarishlarni ko‘rib chiqish
/security-check  — xavfsizlik auditi (payments | fulfillment | auth | admin | all)
/verify          — lint + typecheck + testlar
/phase-report    — bosqich hisoboti (o‘zbekcha)
/implement-design <ekran>  — dizayndan ekran qurish
/add-game <o‘yin> [ta’minotchi]  — yangi o‘yin qo‘shish (MVP'dan keyin)
```

Oddiy kun: `/next-task` → reja ko‘rsatiladi → "ha" deysiz → agentlar quradi → `/phase-report` →
o‘zingiz tekshirasiz → commit (o‘zingiz yoki "commit qil" deb).

---

## 2. Nechta agent va nima uchun

Jami **11 ta subagent** (`.claude/agents/`). Ular parallel ishlashi mumkin, lekin har biri faqat o‘z
hududini o‘zgartiradi.

| Agent | Model | Vazifasi | Kod yozadimi |
|---|---|---|---|
| `planner` | Opus | Roadmap'dan keyingi vazifani olib, reja tuzadi, kim nima qilishini taqsimlaydi | Yo‘q |
| `backend-engineer` | Sonnet | API: auth, katalog, narx, hamyon, buyurtmalar, referal, admin API | Ha |
| `payments-engineer` | Opus | Click, Payme, Uzum, Rahmat (+ Stars) — kiruvchi pul | Ha |
| `fulfillment-engineer` | Opus | Worker: Fragment, TON hamyon, ta'minotchilar — chiquvchi pul | Ha |
| `bot-engineer` | Sonnet | grammY bot, uz/ru, bildirishnomalar, rassilka | Ha |
| `frontend-engineer` | Sonnet | Next.js (landing, web, Mini App), admin panel, dizayn handoff | Ha |
| `test-engineer` | Sonnet | Unit/integration/e2e testlar, ayniqsa pul holatlari | Ha (testlar) |
| `e2e-qa` | Sonnet | Playwright: foydalanuvchi yo‘llari, skrinshotlar, dizayn bilan solishtirish | Ha (testlar) |
| `code-reviewer` | Opus | Diff'ni "buzishga" urinadi, verdict beradi | **Yo‘q** (faqat o‘qiydi) |
| `security-auditor` | Opus (max) | Xavfsizlik auditi: sirlar, auth, to‘lov, hamyon, admin | **Yo‘q** (faqat o‘qiydi) |
| `devops` | Sonnet | Docker, CI, Railway, monitoring, backup | Ha |

**Nega pul bilan ishlaydigan agentlar Opus'da:** to‘lov va yetkazishda bitta xato real pulga tushadi.
**Nega reviewer va auditor kod yozmaydi:** o‘z ishini o‘zi baholamasligi uchun — mustaqil tekshiruv.

Test bilan bog‘liq agentlar 3 ta: `test-engineer` (unit/API), `e2e-qa` (brauzer/vizual), `code-reviewer`
(testlar haqiqatan nimanidir tekshirayotganini ham ko‘radi).

---

## 3. Setup tarkibi

```
CLAUDE.md                  — har sessiyada yuklanadigan asosiy qoidalar (stek, invariantlar, ish tartibi)
.claude/
  agents/      11 ta subagent
  rules/       11 ta qoida (ba'zilari faqat tegishli papkalarda yuklanadi)
  skills/      12 ta skill (nestjs-module, money-ledger, payment-provider, fragment-ton,
               supplier-adapter, grammy-bot-i18n, telegram-webapp-auth, design-handoff,
               react-query-hook, e2e-test, i18n-strings, prisma-migration)
  commands/    8 ta slash-buyruq
  hooks/       guard-bash, guard-files, post-edit, session-start
  settings.json  ruxsatlar, hook'lar, pluginlar, xavfsiz standartlar
.mcp.json      postgres (dev DB), context7 (hujjatlar), playwright (brauzer)
docs/          spetsifikatsiya (o‘zbekcha) — haqiqat manbai
design/        Claude Design promptlari, reference'lar, handoff
.github/workflows/  CI (verify + e2e), Security (gitleaks, npm audit, ixtiyoriy Claude security review)
```

### Qoidalar (`.claude/rules/`)
`00-core` (rostgo‘ylik, doira, hisobot), `10-backend-nestjs`, `20-database-prisma`, `30-frontend`,
`35-i18n` (uz + ru), `40-domain-money` (ledger, xarid), `45-fulfillment` (holatlar, TON), `50-payments`,
`60-security`, `70-testing`, `80-git-workflow`.

### Hook'lar — agent "unutsa" ham ishlaydigan himoya
| Hook | Nima qiladi |
|---|---|
| `guard-bash` | `migrate reset`, `DROP`, `rm -rf` (loyiha papkalari), `git push --force`, `git reset --hard`, `.env` ni chiqarish, sirli o‘zgaruvchilarni `echo` qilish, dry-run'ni o‘chirish, mainnet'ga o‘tish, Fragment/TON yuborish va production to‘lov endpointlariga to‘g‘ridan-to‘g‘ri murojaatni **bloklaydi** |
| `guard-files` | `.env`, `*.pem`, `*.key`, `secrets/` ni o‘qish/yozishni bloklaydi; kodga mnemonic, bot tokeni, Fragment cookie'lari, live kalit yozishni bloklaydi |
| `post-edit` | Prettier bilan formatlaydi; `schema.prisma` o‘zgarsa `prisma validate` qiladi |
| `session-start` | Har sessiya boshida joriy bosqichni va xavfsiz standartlarni eslatadi |

### Pluginlar (rasmiy, Anthropic)
| Plugin | Nima uchun |
|---|---|
| `security-guidance` | Tahrirlarda xavfli naqshlar haqida ogohlantirish + diff review (injection, XSS, SSRF, sirlar va 25+ tur) |
| `claude-security` | Chuqur zaiflik skaneri, topilmalarni tekshirib, patch taklif qiladi |
| `code-review`, `pr-review-toolkit` | PR'lar uchun ko‘p-agentli review |
| `frontend-design` | Sifatli UI implementatsiyasi |
| `typescript-lsp` | Tiplar bo‘yicha aniq navigatsiya |
| `claude-md-management` | CLAUDE.md ni toza va dolzarb saqlash |

---

## 4. Hujjatlar

| Fayl | Mazmuni |
|---|---|
| `docs/01-PRD.md` | Nima quriladi va nega |
| `docs/02-ARCHITECTURE.md` | Ilovalar, modullar, navbatlar, oqimlar, deploy |
| `docs/03-DATA-MODEL.md` | Prisma sxemasi (loyiha, tekshirilgan) |
| `docs/04-API-CONTRACT.md` | Endpointlar, xato kodlari |
| `docs/05-PAYMENTS.md` | Click, Payme, Uzum, Rahmat, Stars |
| `docs/06-FULFILLMENT.md` | Fragment + TON, ta'minotchilar, holatlar, limitlar |
| `docs/07-BOT.md` | Bot (uz/ru), payload'lar, xabarlar, rassilka |
| `docs/08-FRONTEND-SPEC.md` | Ekranlar, holatlar, Mini App integratsiyasi |
| `docs/09-ADMIN-PANEL.md` | Rollar, bo‘limlar, amallar |
| `docs/10-SECURITY.md` | Tahdidlar modeli, launch oldi tekshiruvi |
| `docs/11-ROADMAP.md` | Bosqichlar va qabul mezonlari — **agent shu yerdan boshlaydi** |
| `docs/12-DEFINITION-OF-DONE.md` | "Tayyor" degani nima |
| `docs/13-DECISIONS.md` | Qarorlar va **siz hal qilishingiz kerak bo‘lgan ochiq savollar** |
| `design/DESIGN-BRIEF.md` | Claude Design uchun 10 ta prompt |

---

## 5. Siz hal qilishingiz kerak bo‘lgan narsalar (qisqa)

`docs/13-DECISIONS.md` da batafsil. Eng muhimlari:
- **D-03** — Telegram'ning "raqamli mahsulot uchun to‘lov Stars'da" qoidasiga munosabat (4-bosqichdan oldin).
- **D-04** — birinchi ulanadigan provayder: Click yoki Payme.
- **D-13** — hal qilindi (2026-10-27): brend `ggpin`, domen `ggpin.uz`, bot `@ggpin_bot`.
- **D-14 / D-15** — so‘m → USDT/TON konvertatsiyasi va fiskal chek (buxgalter bilan).

## 6. Xavfsiz standartlar

- `FULFILLMENT_DRY_RUN=true` — hech narsa haqiqatan yuborilmaydi, simulyator ishlaydi.
- To‘lovlar — faqat sandbox. TON — testnet (aniq sozlansa).
- Real pul bilan birinchi sinov faqat sizning ruxsatingiz bilan, kichik summada, o‘z akkauntingizga.
