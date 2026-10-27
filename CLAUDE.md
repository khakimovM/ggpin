# CLAUDE.md — ggpin

> Standing instructions for every Claude Code session and subagent in this repo.
> Brand: **ggpin** (always lowercase; "gg" = "good game"), domain `ggpin.uz`, bot `@ggpin_bot`.
> In code the brand lives in exactly one place (`packages/shared/src/brand.ts`) and in env
> (`BRAND_NAME`, `TELEGRAM_BOT_USERNAME`, `NEXT_PUBLIC_BOT_USERNAME`). Never hardcode it elsewhere.

## 1. What this project is

**ggpin** is a digital top-up store for Uzbekistan, sold through a **Telegram bot + Mini App**
and a **website** (landing + full web store). Users top up a so'm wallet (Click, Payme,
Uzum, Rahmat) and buy:

1. **Telegram Stars** and **Telegram Premium** — bought by us on Fragment with our TON wallet
   and delivered straight to the customer's @username. **Built first.**
2. **Game top-ups**, added one by one after launch: PUBG Mobile (UC), Mobile Legends
   (diamonds), Steam wallet (+ CS2), Roblox (gift codes / Robux), then others — through B2B
   supplier APIs.

Functionally it matches @buypinbot (catalog, wallet, history, referral 1%, cashback coins,
discount codes, bonus codes, support) but with a much better design. There is an **admin
panel** for the owner and operators. The bot and all UI work in **two languages: Uzbek
(default) and Russian**.

This is a production system that moves real money. Correctness and security outrank speed.

## 2. Stack (non-negotiable — ask before adding anything)

| Layer | Choice |
|---|---|
| Monorepo | npm workspaces + Turborepo |
| API | NestJS 10 (Fastify), TypeScript strict |
| Worker | NestJS standalone app (`apps/worker`) — BullMQ consumers, the ONLY process holding wallet keys and supplier secrets |
| DB / ORM | PostgreSQL 16 + Prisma 5 |
| Queue / cache | Redis 7 + BullMQ |
| Bot | grammY (inside `apps/api`, webhook in prod, long polling in dev) |
| Web | Next.js 15 App Router (`apps/web`): landing (SSR/SEO), web store, Mini App routes `/tg/*` |
| Admin | React 18 + Vite SPA (`apps/admin`), separate subdomain |
| i18n | `next-intl` (web), shared message catalogs in `packages/i18n` (uz, ru); bot uses the same catalogs |
| UI | Tailwind CSS + shadcn/ui style components in `packages/ui`, lucide-react, Framer Motion |
| Server state | TanStack Query v5 (web + admin); Zustand only for client-only state |
| Validation | Zod everywhere (`nestjs-zod` on API); schemas live in `packages/shared` |
| TON | `@ton/ton`, `@ton/crypto` (worker only) |
| Tests | Jest + Supertest (api, worker), Vitest + Testing Library (web, admin), Playwright (e2e) |
| Deploy | Docker → Railway (api, worker, web, admin as separate services) |

No Express, no Redux, no Moment.js, no `any`, no floating-point money.

## 3. Repository layout

```
apps/
  api/        NestJS: REST API, payments webhooks, Telegram bot, admin API
  worker/     NestJS standalone: fulfillment (Fragment/TON, suppliers), price sync, reconcilers
  web/        Next.js: landing, web store, Telegram Mini App (/tg)
  admin/      React + Vite: admin panel
packages/
  shared/     Zod schemas, DTO types, money utils, order state machine, brand constants
  i18n/       uz.json / ru.json message catalogs (web, bot, emails)
  ui/         design tokens (from Claude Design handoff) + shared components
docs/         specification — the source of truth (Uzbek)
design/       Claude Design prompts and handoff bundle
.claude/      agents, rules, skills, commands, hooks
```

## 4. Read the spec before building

| Question | File |
|---|---|
| What and why? | `docs/01-PRD.md` |
| How is it structured? | `docs/02-ARCHITECTURE.md` |
| Database? | `docs/03-DATA-MODEL.md` |
| Endpoints? | `docs/04-API-CONTRACT.md` |
| Payments (Click/Payme/Uzum/Rahmat)? | `docs/05-PAYMENTS.md` |
| Fulfillment (Fragment, TON, suppliers)? | `docs/06-FULFILLMENT.md` |
| Bot (uz/ru)? | `docs/07-BOT.md` |
| Screens? | `docs/08-FRONTEND-SPEC.md` + `design/handoff/` |
| Admin panel? | `docs/09-ADMIN-PANEL.md` |
| Security model? | `docs/10-SECURITY.md` |
| **What do I build next?** | `docs/11-ROADMAP.md` ← start here |
| When is a task done? | `docs/12-DEFINITION-OF-DONE.md` |
| Decisions and open questions | `docs/13-DECISIONS.md` |
| Claude Design prompts | `design/DESIGN-BRIEF.md` |

`docs/04-API-CONTRACT.md` is a contract. If an implementation would change a response shape,
stop and ask.

## 5. Domain invariants — breaking one is a critical bug

1. **Money is `BigInt` in minor units.** So'm in tiyin (1 so'm = 100 tiyin); USDT in
   micro-units (1e-6); TON in nanotons (1e-9). Never `Float`/`Number` for money. JSON
   carries money as strings.
2. **Wallet balance is never stored.** It is `SUM(ledger)` per user, cached in Redis and
   invalidated on every ledger write. Cashback coins have their own ledger.
3. **Every money movement is a ledger entry inside `prisma.$transaction`**, together with
   the state change that caused it (payment confirmed → TOPUP entry; order paid → PURCHASE
   entry; order failed → REFUND entry). Never two separate awaits.
4. **Idempotency everywhere money crosses a boundary**: payment webhooks (provider txn id
   unique), order creation (client idempotency key), supplier/Fragment calls (orderId as
   key). A retry must never pay twice. If we cannot prove a Fragment/TON payment did NOT go
   out, the order goes to `NEEDS_REVIEW`, never back to the queue.
5. **Price is locked at checkout** (quote with expiry). Fulfillment re-checks real cost; if
   cost exceeds the locked price's margin floor, the order is held, not sold at a loss.
6. **Every user query is scoped to the owner** (`userId` from the verified session only).
   Another user's resource → 404.
7. **Secrets never leave the worker.** TON mnemonic, Fragment cookies, supplier API keys
   are read only in `apps/worker`. The API and web never import them.
8. **Recipient is confirmed before payment.** Username/player ID/Steam login is validated
   and the resolved name shown to the user before the order can be paid.

Full detail: `.claude/rules/40-domain-money.md`, `45-fulfillment.md`, `50-payments.md`.

## 6. Commands

```bash
npm install
npm run db:up          # postgres + redis (docker compose)
npm run db:migrate     # prisma migrate dev
npm run db:seed        # demo catalog, demo users
npm run dev            # api :5000, worker, web :3000, admin :5173
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run verify         # lint + typecheck + test — run before saying "done"
```

## 7. How to work

- **One roadmap phase at a time** (`docs/11-ROADMAP.md`). Meet its acceptance criteria,
  run `npm run verify`, report with `/phase-report`, then stop.
- **Plan first** for anything beyond a one-file change: phase, files, schema changes.
- **Vertical slices**: Zod schema in shared → Prisma → repository → service → controller →
  API client → hook → UI → i18n strings (uz + ru) → tests.
- **Use the subagents** (see `.claude/agents/`): delegate by domain; always run
  `code-reviewer` and `security-auditor` before closing a phase that touches money,
  auth, payments or fulfillment.
- **Never claim it works without running it.** Paste real command output.
- UI work follows the Claude Design handoff in `design/handoff/` pixel-for-pixel.

## 8. Ask before you

- drop/rename a column, `prisma migrate reset`, any destructive DB command
- change an endpoint contract
- add a runtime dependency
- commit, push, or touch git history
- call a real payment provider, Fragment, TON mainnet or a supplier with real money
  (dev uses sandbox/test modes and the `FULFILLMENT_DRY_RUN=true` flag)

## 9. Style

- TypeScript strict; no `any`, no `!` to silence the compiler, no `@ts-ignore`.
- Code, identifiers, comments, commits: **English**. User-facing text: **Uzbek and
  Russian** through `packages/i18n` only — no hardcoded UI strings.
- Conventional commits: `feat(api): add stars order flow`.
- Files ≤ 300 lines. Comments explain *why*.
- Reports to the owner are written in **Uzbek**.
