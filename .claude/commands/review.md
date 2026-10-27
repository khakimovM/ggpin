---
description: Review the current diff with the code-reviewer subagent before committing.
---
Use the **code-reviewer** subagent on the current working diff (`git diff` and `git diff --staged`).
Return its findings table and verdict. If any finding is a blocker, propose the fix but do not
apply it until I confirm.
