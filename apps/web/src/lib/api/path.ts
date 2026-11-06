import { ResourceIdSchema } from '@repo/shared';
import { ApiError } from './errors';

/**
 * A resource id that is about to become a URL path segment. Anything that is not an id (slashes,
 * dots, control characters, empty) is a request the server would answer with 404 anyway, so it
 * fails here, without a request, with the same error. This also keeps `../` out of paths.
 */
export function resourceId(value: string): string {
  if (!ResourceIdSchema.safeParse(value).success) {
    throw new ApiError({ status: 404, code: 'NOT_FOUND' });
  }
  return value;
}
