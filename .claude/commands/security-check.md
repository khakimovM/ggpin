---
description: Full security audit of the current state (or the given area) with the security-auditor subagent.
argument-hint: "[area: payments | fulfillment | auth | admin | all]"
---
Run the **security-auditor** subagent on area: $ARGUMENTS (default: all).
Also run, if available: `npx gitleaks detect --no-banner`, `npm audit --omit=dev`.
If the `claude-security` plugin is installed, run its scan on the same area as a second opinion.
Return the findings table and the launch verdict in Uzbek. Do not edit code.
