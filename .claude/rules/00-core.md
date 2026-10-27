# Core engineering rules (always active)

## Truthfulness
- Never report a task complete without running the verification command and reading its output.
- If you could not verify something, say "not verified because X".
- If `docs/` is ambiguous, ask. Do not invent a resolution. Check `docs/13-DECISIONS.md` first.
- Never fabricate file paths, package names, API responses, provider behaviour or test results.
  Payment provider and Fragment behaviour must come from their docs or recorded fixtures.

## Scope discipline
- Change only what the current task requires. No drive-by refactors, no dependency bumps.
- Note unrelated problems in the report; do not fix them silently.
- Never start the next roadmap phase in the same run.

## Failure handling
- A failing test means the code is wrong until proven otherwise. Fix the code, not the test.
- Never use `.skip`, `.only`, `@ts-ignore`, `eslint-disable`, `as any` to pass a check.
- Three failed attempts at the same fix → stop and report what you tried.

## TypeScript
- `strict: true`. No `any` (use `unknown` + narrowing). No non-null `!`.
- Derive types from Zod (`z.infer`). One source of truth per schema, in `packages/shared`.

## Files
- ≤ ~300 lines; one exported class/component per file; barrels only at package boundaries.

## Reporting (end every task with this, in Uzbek)
- **Bajarildi** — what now works
- **Tekshirildi** — exact commands and their real result
- **Bajarilmadi / taxminlar** — skipped, guessed, needs a decision
- **Keyingi qadam** — next roadmap item
