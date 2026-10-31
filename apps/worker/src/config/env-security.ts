// Secret policy for the worker process. The name lists and the pure helpers live in
// @repo/shared (shared with the API); this file only binds them to the worker's groups.
import {
  WORKER_PRODUCTION_GENERATED_SECRETS,
  WORKER_PRODUCTION_ISSUED_CREDENTIALS,
  productionSecretProblems as sharedProductionSecretProblems,
} from '@repo/shared';

export { apiSecretProblems, isBlank } from '@repo/shared';

type Source = Readonly<Record<string, string | undefined>>;

// The worker is the ONLY process allowed to hold the wallet/supplier secrets (CLAUDE.md §5.7).
// They are optional until phases 5-6 but, when present, subject to the production
// placeholder rule.
export function productionSecretProblems(source: Source): string[] {
  return sharedProductionSecretProblems(
    source,
    WORKER_PRODUCTION_GENERATED_SECRETS,
    WORKER_PRODUCTION_ISSUED_CREDENTIALS,
  );
}
