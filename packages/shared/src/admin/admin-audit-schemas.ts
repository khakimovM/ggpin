// `/api/v1/admin/audit-log*` (docs/04 "Admin" — audit; docs/09 §9; D-63 (3)): read for OWNER and
// OPERATOR, the CSV export for OWNER only (and audited itself, `AUDIT_EXPORT`).
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { AuditActionFilterSchema, AuditActorTypeSchema } from './admin-audit-actions';
import {
  IsoDateTimeSchema,
  RANGE_ORDER_ISSUE,
  adminDateRangeShape,
  adminPageQueryShape,
  adminQueryInt,
  isOrderedRange,
} from './admin-common-schemas';

const auditFilterShape = {
  ...adminDateRangeShape,
  actorType: AuditActorTypeSchema.optional(),
  actorId: ResourceIdSchema.optional(),
  action: AuditActionFilterSchema.optional(),
  targetType: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{1,63}$/)
    .optional(),
  targetId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_:.-]+$/)
    .optional(),
} as const;

export const AdminAuditListQuerySchema = z
  .strictObject({ ...adminPageQueryShape, ...auditFilterShape })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminAuditListQuery = z.infer<typeof AdminAuditListQuerySchema>;

/** The CSV export takes the same filters and at most 10 000 rows (newest first), no paging. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
export const AdminAuditExportQuerySchema = z
  .strictObject({
    ...auditFilterShape,
    limit: adminQueryInt(AUDIT_EXPORT_MAX_ROWS)
      .refine((n) => n >= 1, { message: 'limit must be positive' })
      .default(AUDIT_EXPORT_MAX_ROWS),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminAuditExportQuery = z.infer<typeof AdminAuditExportQuerySchema>;

/** Column order of the CSV export (header row). */
export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'actorType',
  'actorId',
  'actorName',
  'action',
  'targetType',
  'targetId',
  'reason',
  'ip',
  'before',
  'after',
] as const;

/**
 * `before` / `after` as stored, then passed through `redactAuditJson` for every role: secret-named
 * keys read `[redacted]` (review SA-M4).
 */
const AuditJsonSchema = z.record(z.string(), z.unknown()).nullable();

export const AdminAuditRowSchema = z.strictObject({
  id: ResourceIdSchema,
  createdAt: IsoDateTimeSchema,
  actor: z.strictObject({
    type: AuditActorTypeSchema,
    id: z.string().nullable(),
    /** The admin's name for ADMIN, the CLI operator for CLI, null for SYSTEM. */
    name: z.string().nullable(),
  }),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  before: AuditJsonSchema,
  after: AuditJsonSchema,
  reason: z.string().nullable(),
  ip: z.string().nullable(),
});
export type AdminAuditRow = z.infer<typeof AdminAuditRowSchema>;

export const AdminAuditListResponseSchema = z.array(AdminAuditRowSchema);
export type AdminAuditListResponse = z.infer<typeof AdminAuditListResponseSchema>;
