# Git workflow (always active)

- `main` always green. Branch per phase/task: `feat/p5-stars-order`, `fix/payme-cancel`.
- Conventional commits, scopes: api, worker, web, admin, shared, ui, i18n, db, ci, docs.
- One logical change per commit; migration + code that uses it together.
- Never commit `.env`, secrets, `node_modules`, `dist`, `.next`, Playwright traces with tokens.
- Do not commit, amend, rebase or push without the owner's request.
- Before a PR: `npm run verify` green, phase acceptance criteria met, `code-reviewer`
  verdict "ship", and `security-auditor` verdict for sensitive phases.
