---
paths:
  - "apps/web/**"
  - "apps/admin/**"
  - "packages/ui/**"
---
# Frontend rules — Next.js (web), React + Vite (admin)

- Design source of truth: `design/handoff/`. Tokens → `packages/ui/tokens.css` → Tailwind
  theme. No raw hex in components. Fonts must support Uzbek Latin (o‘ g‘ ʼ) and Cyrillic.
- Next.js: Server Components by default; `"use client"` only for interactive leaves.
  Landing routes: static/ISR, `generateMetadata`, OpenGraph, `hreflang` (uz, ru), sitemap.
- Routes: `/[locale]/(marketing)/...` landing, `/[locale]/(store)/...` web store,
  `/tg/...` Mini App (locale from user profile, no locale prefix).
- Data: TanStack Query; keys from `src/lib/query-keys.ts`; every mutation declares its
  invalidations (wallet balance after top-up/purchase, orders after purchase).
- State: Zustand for UI-only state (sheet open, selected SKU before checkout).
- Four states for every data view: skeleton, error + "Qayta urinish", empty + CTA, success.
- Money: `formatMoney(tiyin, locale)` from shared; inputs collect so'm, send tiyin strings.
  Never compute final prices client-side — always show the server quote.
- Mini App: `@telegram-apps/sdk` (or `window.Telegram.WebApp`) — `ready()`, `expand()`,
  theme params → CSS vars, safe-area insets, native BackButton, MainButton for the primary
  action, `HapticFeedback` on success/error. Payments open via `openLink` when required.
- Accessibility: WCAG AA, focus visible, touch targets ≥ 44px, reduced motion.
- Animations (Framer Motion): purposeful, ≤ 300ms for UI, disabled under reduced motion.
