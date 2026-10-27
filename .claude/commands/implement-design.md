---
description: Implement a screen or flow from the Claude Design handoff bundle.
argument-hint: "<screen or flow name>"
---
Use the **frontend-engineer** subagent with skill `design-handoff` to implement: $ARGUMENTS.
Read `design/handoff/` first. Build missing `packages/ui` components before the screen.
All strings via i18n (uz + ru). Then run **e2e-qa** for screenshots at 375/768/1440, light/dark,
uz/ru, and list deviations from the design.
