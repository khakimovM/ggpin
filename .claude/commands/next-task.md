---
description: Take the next unfinished roadmap task, plan it with the planner, implement it with the right subagents, verify and report.
---
1. Use the **planner** subagent: read `docs/11-ROADMAP.md`, find the first phase whose acceptance
   criteria are not met (verify in code), and produce the plan.
2. Show me the plan in Uzbek. If it changes the DB schema, an API contract, adds a dependency,
   or touches real money — wait for my approval. Otherwise continue.
3. Implement slice by slice with the domain subagents named in the plan.
4. Run **test-engineer** for missing tests, then `npm run verify` and paste the real output.
5. Run **code-reviewer**; if the phase touches money/auth/payments/fulfillment/admin also run
   **security-auditor**. Fix blockers.
6. Finish with `/phase-report`. Do not start the next phase.
