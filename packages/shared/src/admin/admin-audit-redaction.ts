// Pure helpers the admin API applies to audit rows before they leave the server (docs/04 "Admin"
// — audit; reviews SA-M4, SA-M8, M-2 / N2). Audit `before` / `after` are free JSON written by
// many services (CLI, worker, panel), so the panel never trusts them to be clean: a secret key's
// value is replaced at any depth for every role (admin-audit-keys.ts says which), and the IP and
// bank message fields follow the reader's role. The owner CLI still reads the raw row.
import { isAuditBankMessageKey, isAuditIpKey, isAuditSecretKey } from './admin-audit-keys';

export const AUDIT_REDACTED = '[redacted]';

/** What the reader's role may see inside audit JSON (beyond the secrets nobody sees). */
export interface AuditRedactionView {
  /** `audit.ipFull`: IP fields as written; otherwise `maskIp` of them. */
  readonly ipFull: boolean;
  /** `payments.bankMessageRaw`: bank message fields as written; otherwise `null`. */
  readonly bankMessageRaw: boolean;
  /** The API's IP mask (IPv4 /24, IPv6 /48); `null` for anything that is not an address. */
  readonly maskIp: (ip: string) => string | null;
}

function redactField(key: string, child: unknown, view: AuditRedactionView): unknown {
  if (isAuditSecretKey(key)) return AUDIT_REDACTED;
  if (isAuditIpKey(key) && !view.ipFull) {
    return typeof child === 'string' ? view.maskIp(child) : null;
  }
  if (isAuditBankMessageKey(key) && !view.bankMessageRaw) return null;
  return redactAuditJson(child, view);
}

/** A copy of `value` as the reader may see it: secrets replaced, IP and bank fields by role. */
export function redactAuditJson(value: unknown, view: AuditRedactionView): unknown {
  if (Array.isArray(value)) return value.map((child) => redactAuditJson(child, view));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      redactField(key, child, view),
    ]),
  );
}

/** Paths (`a.b[0].c`) of secret keys whose value is not redacted yet; `[]` when clean. */
export function findAuditSecretPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, i) => findAuditSecretPaths(child, `${path}[${String(i)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    isAuditSecretKey(key) && child !== AUDIT_REDACTED
      ? [`${path}.${key}`]
      : findAuditSecretPaths(child, `${path}.${key}`),
  );
}

// A cell that a spreadsheet would run as a formula: after any leading whitespace it starts with
// = + - @ or their full-width forms; a leading tab or carriage return is refused on its own.
const FORMULA_START = /^\s*[=+\-@＝＋－＠]/u;
const CONTROL_START = /^[\t\r]/;

// Audit JSON read through Prisma may carry a bigint; JSON.stringify would throw on it (m-7).
const bigintAsString = (_key: string, child: unknown): unknown =>
  typeof child === 'bigint' ? child.toString() : child;

/**
 * One RFC 4180 cell of the audit CSV export: objects become JSON first, a formula-like start gets
 * a leading `'` (checked on the final text, so JSON cannot smuggle one in), and the cell is always
 * quoted with inner `"` doubled. `null` / `undefined` is an empty quoted cell.
 */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'object') text = JSON.stringify(value, bigintAsString);
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else text = ''; // a function or a symbol has no cell
  if (FORMULA_START.test(text) || CONTROL_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** One CSV line (CRLF is added by the writer between lines). */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
