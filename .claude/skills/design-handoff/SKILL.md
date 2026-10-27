---
name: design-handoff
description: Implement screens from the Claude Design handoff bundle in design/handoff/ — map tokens to Tailwind, build packages/ui components, recreate screens pixel-perfectly in Next.js / React with uz+ru strings and all view states. Use for any UI implementation task.
---

# Implementing the Claude Design handoff

1. Read `design/handoff/README.md` and the primary file it names, top to bottom; follow every import.
2. Do not render or screenshot the prototypes unless asked — read the HTML/CSS source.
3. Tokens: copy CSS variables into `packages/ui/tokens.css` (light + dark + Telegram theme
   mapping) and expose them in `tailwind.config` as semantic names. No new colours.
4. Components first (`packages/ui`): Button, Input, MoneyInput, Sheet/Modal, Tabs, Chip,
   ProductCard, SkuTile, RecipientConfirm, OrderStatus, Skeleton, EmptyState, ErrorState, Toast.
5. Screens: match spacing/typography exactly; replace sample text with i18n keys (uz from the
   design, ru translated — check overflow).
6. Each screen: loading, empty, error, success; 375/768/1440; light/dark; Mini App variant.
7. Motion: copy durations/easings from the design system; honour reduced motion.
8. Ask before deviating; list any ambiguity instead of guessing.
