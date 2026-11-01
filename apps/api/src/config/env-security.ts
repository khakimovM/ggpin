// Secret policy for the API process. The name lists and the pure helpers live in
// @repo/shared (shared with the worker); this file only binds them to the API's groups.
import {
  API_PRODUCTION_GENERATED_SECRETS,
  API_PRODUCTION_ISSUED_CREDENTIALS,
  productionSecretProblems as sharedProductionSecretProblems,
} from '@repo/shared';

export { isBlank, workerSecretProblems } from '@repo/shared';

type Source = Readonly<Record<string, string | undefined>>;

export function productionSecretProblems(source: Source): string[] {
  return sharedProductionSecretProblems(
    source,
    API_PRODUCTION_GENERATED_SECRETS,
    API_PRODUCTION_ISSUED_CREDENTIALS,
  );
}
