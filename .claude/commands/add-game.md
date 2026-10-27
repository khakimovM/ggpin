---
description: Add a new game top-up product (and its supplier adapter if needed) end to end.
argument-hint: "<game name> [supplier]"
---
Goal: add **$ARGUMENTS** to the catalog.
1. **planner**: check `docs/06-FULFILLMENT.md` and `docs/suppliers/` — does an adapter exist for this
   supplier? List delivery type, inputs (player id / zone / login / voucher), regions, SKUs.
2. If the supplier docs are missing, stop and ask me for them (API docs, test credentials).
3. **fulfillment-engineer**: adapter (skill `supplier-adapter`), fixtures, dry-run simulator.
4. **backend-engineer**: product + SKUs seed, input schema, help texts (uz + ru).
5. **frontend-engineer**: verify the generic product page renders the new input schema; add the
   "how to find your ID" sheet content and images.
6. **test-engineer** + **e2e-qa**: quote → buy → delivered (dry run) and invalid-id path.
7. **code-reviewer** + **security-auditor**, then `/phase-report`.
