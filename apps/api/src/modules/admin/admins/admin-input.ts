import { validationError } from '../../../common/admin/admin-input';

/** The parsed value of a shared schema, or the VALIDATION_ERROR naming `field`. */
export function parsed<T>(
  field: string,
  result: { success: true; data: T } | { success: false },
): T {
  if (!result.success) throw validationError(field);
  return result.data;
}
